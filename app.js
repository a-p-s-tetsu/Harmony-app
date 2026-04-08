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

  const micRecordBtn = document.getElementById("micRecordBtn");
  const stopRecordBtn = document.getElementById("stopRecordBtn");
  const playRecordedBtn = document.getElementById("playRecordedBtn");
  const recordedAudio = document.getElementById("recordedAudio");
  const statusEl = document.getElementById("status");
  const hzEl = document.getElementById("hz");
  const noteEl = document.getElementById("note");
  const harmonyHzEl = document.getElementById("harmonyHz");
  const harmonyNoteEl = document.getElementById("harmonyNote");
  const confidenceEl = document.getElementById("confidence");
  const harmonyIntervalEl = document.getElementById("harmonyInterval");

  let appAudioContext = null;
  let pitchDetector = null;
  /** 現在の CREPE がマイクストリームを見ているとき true（再生キャプチャ時は false） */
  let pitchUsesMicStream = true;
  let mediaStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordedObjectUrl = null;
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

  function disposePitchDetector() {
    stopLoop();
    if (pitchDetector && typeof pitchDetector.dispose === "function") {
      pitchDetector.dispose();
    }
    pitchDetector = null;
  }

  function pickRecorderMimeType() {
    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
    ];
    for (let i = 0; i < types.length; i++) {
      if (MediaRecorder.isTypeSupported(types[i])) {
        return types[i];
      }
    }
    return "";
  }

  function getCaptureStreamFromMedia(el) {
    if (el.captureStream) {
      return el.captureStream();
    }
    if (el.mozCaptureStream) {
      return el.mozCaptureStream();
    }
    return null;
  }

  function startRecordingWithExistingStream() {
    if (!mediaStream || !mediaStream.active) {
      return;
    }
    if (mediaRecorder && mediaRecorder.state === "recording") {
      return;
    }
    recordedChunks = [];
    const mime = pickRecorderMimeType();
    try {
      mediaRecorder = mime
        ? new MediaRecorder(mediaStream, { mimeType: mime })
        : new MediaRecorder(mediaStream);
    } catch (e) {
      mediaRecorder = new MediaRecorder(mediaStream);
    }
    mediaRecorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };
    mediaRecorder.onstop = function () {
      const type = mediaRecorder.mimeType || "audio/webm";
      const blob = new Blob(recordedChunks, { type: type });
      recordedChunks = [];
      if (recordedObjectUrl) {
        URL.revokeObjectURL(recordedObjectUrl);
        recordedObjectUrl = null;
      }
      recordedObjectUrl = URL.createObjectURL(blob);
      recordedAudio.src = recordedObjectUrl;
      playRecordedBtn.disabled = false;
      setStatus("録音を停止しました。");
      micRecordBtn.disabled = false;
      stopRecordBtn.disabled = true;
    };
    mediaRecorder.start();
    micRecordBtn.disabled = true;
    stopRecordBtn.disabled = false;
    setStatus("Recording…");
  }

  function ensureLivePitchDetector(onReady, onError) {
    if (pitchDetector && pitchUsesMicStream) {
      onReady();
      return;
    }
    disposePitchDetector();
    smoothedHarmonyMidi = null;
    if (harmonySynth) {
      harmonySynth.silence();
    }
    pitchUsesMicStream = true;
    pitchDetector = new CrepePitchDetection(
      CREPE_MODEL_URL,
      appAudioContext,
      mediaStream,
      function (err) {
        if (err) {
          if (typeof onError === "function") {
            onError(err);
          }
          return;
        }
        if (appAudioContext.state === "suspended") {
          appAudioContext.resume().catch(function (e2) {
            console.error(e2);
          });
        }
        onReady();
      }
    );
  }

  function attachPlaybackPitchDetector(onReady, onError) {
    disposePitchDetector();
    smoothedHarmonyMidi = null;
    if (harmonySynth) {
      harmonySynth.silence();
    }
    const cs = getCaptureStreamFromMedia(recordedAudio);
    if (!cs) {
      recordedAudio.pause();
      setStatus("このブラウザでは再生音声のピッチ検出に対応していません。");
      if (typeof onError === "function") {
        onError(new Error("captureStream not supported"));
      }
      return;
    }
    pitchUsesMicStream = false;
    pitchDetector = new CrepePitchDetection(
      CREPE_MODEL_URL,
      appAudioContext,
      cs,
      function (err) {
        if (err) {
          if (typeof onError === "function") {
            onError(err);
          }
          return;
        }
        if (appAudioContext.state === "suspended") {
          appAudioContext.resume().catch(function (e2) {
            console.error(e2);
          });
        }
        onReady();
      }
    );
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
            const intervalSemi = harmonyIntervalEl
              ? parseInt(harmonyIntervalEl.value, 10)
              : 7;
            const offsetSemi = Number.isNaN(intervalSemi) ? 7 : intervalSemi;
            const rawHarmonyMidi = midiIn + offsetSemi;
            if (smoothedHarmonyMidi == null) {
              smoothedHarmonyMidi = rawHarmonyMidi;
            } else {
              smoothedHarmonyMidi =
                smoothedHarmonyMidi * HARMONY_MIDI_SMOOTH_ALPHA +
                rawHarmonyMidi * (1 - HARMONY_MIDI_SMOOTH_ALPHA);
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

  async function startMicAndRecordFirstTime() {
    setStatus("Requesting microphone…");
    try {
      appAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      if (appAudioContext.state === "suspended") {
        await appAudioContext.resume();
      }
    } catch (e) {
      console.error(e);
      setStatus("マイクを利用できませんでした（許可またはデバイスを確認）。");
      micRecordBtn.disabled = false;
      appAudioContext = null;
      mediaStream = null;
      return;
    }

    setStatus("Loading CREPE model…");

    try {
      pitchUsesMicStream = true;
      pitchDetector = new CrepePitchDetection(
        CREPE_MODEL_URL,
        appAudioContext,
        mediaStream,
        function (err) {
          if (err) {
            console.error(err);
            setStatus("モデルの読み込みに失敗しました: " + (err.message || String(err)));
            micRecordBtn.disabled = false;
            if (mediaStream) {
              mediaStream.getTracks().forEach(function (t) {
                t.stop();
              });
            }
            mediaStream = null;
            disposePitchDetector();
            if (appAudioContext) {
              appAudioContext.close().catch(function () {});
              appAudioContext = null;
            }
            return;
          }

          if (appAudioContext.state === "suspended") {
            appAudioContext.resume().catch(function (e2) {
              console.error(e2);
            });
          }

          if (!harmonySynth) {
            harmonySynth = createHarmonySynth(appAudioContext);
          }
          if (!micMonitorSource) {
            micMonitorSource = appAudioContext.createMediaStreamSource(mediaStream);
            micMonitorGain = appAudioContext.createGain();
            micMonitorGain.gain.value = 0.3;
            micMonitorSource.connect(micMonitorGain);
            micMonitorGain.connect(appAudioContext.destination);
          }

          startRecordingWithExistingStream();
          setStatus("Recording…");
          running = true;
          pitchLoop();
        }
      );
    } catch (e) {
      console.error(e);
      setStatus("初期化に失敗しました。");
      micRecordBtn.disabled = false;
      if (mediaStream) {
        mediaStream.getTracks().forEach(function (t) {
          t.stop();
        });
      }
      mediaStream = null;
      disposePitchDetector();
      if (appAudioContext) {
        appAudioContext.close().catch(function () {});
        appAudioContext = null;
      }
    }
  }

  async function onMicRecordClick() {
    if (!window.ml5 || !ml5.tf) {
      setStatus("ml5.js（ml5.tf を含む）の読み込みに失敗しています。");
      return;
    }
    if (!window.CrepePitchDetection) {
      setStatus("crepe-pitch.js が読み込まれていません。");
      return;
    }

    if (recordedAudio && !recordedAudio.paused) {
      recordedAudio.pause();
      recordedAudio.currentTime = 0;
    }

    if (appAudioContext && mediaStream && mediaStream.active) {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        return;
      }
      micRecordBtn.disabled = true;
      setStatus("Loading CREPE model…");
      ensureLivePitchDetector(
        function () {
          startRecordingWithExistingStream();
          running = true;
          pitchLoop();
        },
        function (err) {
          console.error(err);
          setStatus("モデルの読み込みに失敗しました: " + (err.message || String(err)));
          micRecordBtn.disabled = false;
        }
      );
      return;
    }

    micRecordBtn.disabled = true;
    await startMicAndRecordFirstTime();
  }

  function onStopRecordClick() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }

  function onPlayRecordedClick() {
    if (!recordedAudio.src || !appAudioContext) {
      return;
    }
    stopLoop();
    smoothedHarmonyMidi = null;
    if (harmonySynth) {
      harmonySynth.silence();
    }
    disposePitchDetector();
    if (micMonitorGain) {
      micMonitorGain.gain.value = 0;
    }
    recordedAudio.currentTime = 0;
    setStatus("Loading CREPE model…");
    recordedAudio
      .play()
      .then(function () {
        attachPlaybackPitchDetector(
          function () {
            setStatus("再生中（ハモリ付き）…");
            running = true;
            pitchLoop();
          },
          function (err) {
            console.error(err);
            recordedAudio.pause();
            if (micMonitorGain) {
              micMonitorGain.gain.value = 0.3;
            }
            micRecordBtn.disabled = false;
          }
        );
      })
      .catch(function (e) {
        console.error(e);
        setStatus("再生を開始できませんでした。");
        if (micMonitorGain) {
          micMonitorGain.gain.value = 0.3;
        }
      });
  }

  recordedAudio.addEventListener("ended", function () {
    stopLoop();
    smoothedHarmonyMidi = null;
    if (harmonySynth) {
      harmonySynth.silence();
    }
    disposePitchDetector();
    if (micMonitorGain) {
      micMonitorGain.gain.value = 0.3;
    }
    if (appAudioContext && mediaStream && mediaStream.active) {
      setStatus("Loading CREPE model…");
      ensureLivePitchDetector(
        function () {
          setStatus("Listening…");
          running = true;
          pitchLoop();
        },
        function (err) {
          console.error(err);
          setStatus("ライブ検出の再開に失敗しました。");
        }
      );
    } else {
      setStatus("再生が終わりました。");
    }
  });

  micRecordBtn.addEventListener("click", function () {
    onMicRecordClick();
  });

  stopRecordBtn.addEventListener("click", function () {
    onStopRecordClick();
  });

  playRecordedBtn.addEventListener("click", function () {
    onPlayRecordedClick();
  });

  window.addEventListener("beforeunload", function () {
    stopLoop();
    if (recordedObjectUrl) {
      URL.revokeObjectURL(recordedObjectUrl);
      recordedObjectUrl = null;
    }
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
    disposePitchDetector();
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) {
        t.stop();
      });
    }
  });
})();
