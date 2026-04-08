(function () {
  "use strict";

  const CREPE_MODEL_URL =
    "https://cdn.jsdelivr.net/gh/ml5js/ml5-data-and-models@master/models/pitch-detection/crepe/";

  /** Hz 表示は crepe-pitch の MIN 以上で出る。ハモリだけ ml5 標準に近い厳しさでゲート */
  const HARMONY_MIN_CONFIDENCE = 0.5;

  const NOTE_NAMES = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
  ];

  /* ---------- メジャースケール上の「上の3度」（長3度/短3度を度数で自動選択） ---------- */
  /** メジャー各度数（ルート=0 … 6）から上のディアトニック3度までの半音数 */
  const DIATONIC_THIRD_UP_SEMITONES_MAJOR = [4, 3, 3, 4, 4, 3, 3];

  /**
   * C メジャー相当のピッチクラス（昇順）。キー変更時は同じメジャー型7音の配列に差し替え。
   * @type {number[]}
   */
  let harmonyScalePc = [0, 2, 4, 5, 7, 9, 11];

  /**
   * ハモリ3度の MIDI に加算する半音（例: -12 で1オクターブ下げ）
   * @type {number}
   */
  let harmonyThirdOctaveOffsetSemitones = 0;

  /** ハモリ目標 MIDI の指数平滑（0 に近いほど新値優先、1 に近いほど直前に追従） */
  const HARMONY_MIDI_SMOOTH_ALPHA = 0.78;

  /** @param {number} freq */
  function midiFromFrequency(freq) {
    return 12 * (Math.log(freq / 440) / Math.log(2)) + 69;
  }

  /** @param {number} midi */
  function frequencyFromMidi(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /**
   * 検出ピッチに最も近いスケール音（±12 半音で探索）
   * @param {number} midiFloat
   * @param {number[]} scalePc スケールのピッチクラス 0–11（メジャーなら昇順7音）
   * @returns {number} 整数 MIDI
   */
  function snapToScaleMidi(midiFloat, scalePc) {
    const center = Math.round(midiFloat);
    let best = center;
    let bestDist = Infinity;
    for (let m = center - 12; m <= center + 12; m++) {
      const pc = ((m % 12) + 12) % 12;
      if (scalePc.indexOf(pc) === -1) continue;
      const d = Math.abs(midiFloat - m);
      if (d < bestDist) {
        bestDist = d;
        best = m;
      }
    }
    return best;
  }

  /**
   * メジャースケール上の音から、同調の上3度（長3度/短3度）の MIDI ノート
   * @param {number} midiSnapped スケール上の整数 MIDI
   * @param {number[]} scalePc harmonyScalePc と同一のスケール
   */
  function diatonicThirdAboveInMajorScale(midiSnapped, scalePc) {
    const pc = ((midiSnapped % 12) + 12) % 12;
    const deg = scalePc.indexOf(pc);
    if (deg === -1) {
      return midiSnapped + 4;
    }
    return midiSnapped + DIATONIC_THIRD_UP_SEMITONES_MAJOR[deg];
  }

  /** @param {number} freq */
  function frequencyToNearestNote(freq) {
    const midi = Math.round(12 * (Math.log(freq / 440) / Math.log(2)) + 69);
    const octave = Math.floor(midi / 12) - 1;
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    return name + octave;
  }

  /**
   * Oscillator + Gain。入力が無いときはゲインを下げて実質停止。
   * @param {AudioContext} ctx
   */
  function createHarmonySynth(ctx) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    const peakGain = 0.14;
    const attackTC = 0.045;
    const releaseTC = 0.1;
    const freqTC = 0.03;

    return {
      setHarmonyHz(hz) {
        const t = ctx.currentTime;
        if (hz > 30 && hz < 2200) {
          osc.frequency.setTargetAtTime(hz, t, freqTC);
        }
        gain.gain.setTargetAtTime(peakGain, t, attackTC);
      },
      silence() {
        const t = ctx.currentTime;
        gain.gain.setTargetAtTime(0.0001, t, releaseTC);
      },
      dispose() {
        try {
          osc.stop();
          osc.disconnect();
          gain.disconnect();
        } catch (e) {
          /* ignore */
        }
      },
    };
  }

  const startBtn = document.getElementById("startBtn");
  const statusEl = document.getElementById("status");
  const hzEl = document.getElementById("hz");
  const noteEl = document.getElementById("note");
  const harmonyHzEl = document.getElementById("harmonyHz");
  const harmonyNoteEl = document.getElementById("harmonyNote");
  const confidenceEl = document.getElementById("confidence");

  let pitchDetector = null;
  let mediaStream = null;
  let harmonySynth = null;
  let micMonitorSource = null;
  let micMonitorGain = null;
  let running = false;
  let rafId = 0;
  let smoothedHarmonyMidi = null;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function stopLoop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function pitchLoop() {
    if (!running || !pitchDetector) return;
    pitchDetector.getPitch(function (err, frequency) {
      if (err) {
        console.error(err);
        setStatus("Error: " + (err.message || String(err)));
        hzEl.textContent = "—";
        noteEl.textContent = "—";
        harmonyHzEl.textContent = "—";
        harmonyNoteEl.textContent = "—";
        confidenceEl.textContent = "—";
        if (harmonySynth) {
          harmonySynth.silence();
        }
        smoothedHarmonyMidi = null;
      } else {
        const r = pitchDetector.results || {};
        if (r.confidence != null) {
          confidenceEl.textContent = r.confidence;
        }
        const confNum =
          r.confidence != null && r.confidence !== ""
            ? parseFloat(r.confidence)
            : NaN;
        const confOk = !Number.isNaN(confNum) && confNum >= HARMONY_MIN_CONFIDENCE;

        if (frequency) {
          hzEl.textContent = frequency.toFixed(1);
          noteEl.textContent = frequencyToNearestNote(frequency);

          if (confOk && harmonySynth) {
            const midiIn = midiFromFrequency(frequency);
            const scalePc = harmonyScalePc;
            const snapped = snapToScaleMidi(midiIn, scalePc);
            const rawThirdMidi =
              diatonicThirdAboveInMajorScale(snapped, scalePc) +
              harmonyThirdOctaveOffsetSemitones;
            if (smoothedHarmonyMidi == null) {
              smoothedHarmonyMidi = rawThirdMidi;
            } else {
              smoothedHarmonyMidi =
                smoothedHarmonyMidi * HARMONY_MIDI_SMOOTH_ALPHA +
                rawThirdMidi * (1 - HARMONY_MIDI_SMOOTH_ALPHA);
            }
            const harmonyHz = frequencyFromMidi(smoothedHarmonyMidi);
            harmonyHzEl.textContent = harmonyHz.toFixed(1);
            harmonyNoteEl.textContent = frequencyToNearestNote(harmonyHz);
            harmonySynth.setHarmonyHz(harmonyHz);
          } else {
            harmonyHzEl.textContent = "—";
            harmonyNoteEl.textContent = "—";
            smoothedHarmonyMidi = null;
            if (harmonySynth) {
              harmonySynth.silence();
            }
          }
        } else {
          hzEl.textContent = "—";
          noteEl.textContent = "—";
          harmonyHzEl.textContent = "—";
          harmonyNoteEl.textContent = "—";
          smoothedHarmonyMidi = null;
          if (harmonySynth) {
            harmonySynth.silence();
          }
        }
      }
      rafId = requestAnimationFrame(pitchLoop);
    });
  }

  async function startMicrophone() {
    if (!window.ml5 || !ml5.tf) {
      setStatus("ml5.js（ml5.tf を含む）の読み込みに失敗しています。");
      return;
    }
    if (!window.CrepePitchDetection) {
      setStatus("crepe-pitch.js が読み込まれていません。");
      return;
    }

    startBtn.disabled = true;
    setStatus("Requesting microphone…");

    let audioContext;
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
    } catch (e) {
      console.error(e);
      setStatus("マイクを利用できませんでした（許可またはデバイスを確認）。");
      startBtn.disabled = false;
      return;
    }

    setStatus("Loading CREPE model…");

    try {
      pitchDetector = new CrepePitchDetection(
        CREPE_MODEL_URL,
        audioContext,
        mediaStream,
        function (err) {
          if (err) {
            console.error(err);
            setStatus("モデルの読み込みに失敗しました: " + (err.message || String(err)));
            startBtn.disabled = false;
            if (mediaStream) {
              mediaStream.getTracks().forEach(function (t) {
                t.stop();
              });
            }
            return;
          }

          if (audioContext.state === "suspended") {
            audioContext.resume().catch(function (e2) {
              console.error(e2);
            });
          }

          harmonySynth = createHarmonySynth(audioContext);

          micMonitorSource = audioContext.createMediaStreamSource(mediaStream);
          micMonitorGain = audioContext.createGain();
          micMonitorGain.gain.value = 0.3;
          micMonitorSource.connect(micMonitorGain);
          micMonitorGain.connect(audioContext.destination);

          setStatus("Listening…");
          running = true;
          pitchLoop();
        }
      );
    } catch (e) {
      console.error(e);
      setStatus("初期化に失敗しました。");
      startBtn.disabled = false;
      if (mediaStream) {
        mediaStream.getTracks().forEach(function (t) {
          t.stop();
        });
      }
    }
  }

  startBtn.addEventListener("click", function () {
    startMicrophone();
  });

  window.addEventListener("beforeunload", function () {
    stopLoop();
    if (harmonySynth) {
      harmonySynth.dispose();
      harmonySynth = null;
    }
    try {
      if (micMonitorSource) {
        micMonitorSource.disconnect();
        micMonitorSource = null;
      }
      if (micMonitorGain) {
        micMonitorGain.disconnect();
        micMonitorGain = null;
      }
    } catch (e) {
      /* ignore */
    }
    if (pitchDetector && typeof pitchDetector.dispose === "function") {
      pitchDetector.dispose();
    }
  });
})();
