(function () {
  "use strict";

  const CREPE_MODEL_URL =
    "https://cdn.jsdelivr.net/gh/ml5js/ml5-data-and-models@master/models/pitch-detection/crepe/";

  /** オフライン解析のホップ（秒）。10〜20ms 相当 */
  const ANALYSIS_HOP_SEC = 0.015;

  /** ピッチ列の移動平均窓（フレーム数・奇数推奨） */
  const PITCH_SMOOTH_WINDOW = 5;

  /** これ未満の長さの音符はノイズとして捨てる（秒） */
  const MIN_NOTE_DURATION_SEC = 0.05;

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

  const SONG_PRESETS = {
    cherry: {
      name: "スピッツ - チェリー (サビ)",
      keyRoot: 0,
      scaleType: "major",
      harmonyType: "diatonic_3rd_up",
    },
    parallel_5th: {
      name: "汎用 - 5度上",
      keyRoot: null,
      scaleType: "none",
      harmonyType: "parallel",
      interval: 7,
    },
  };

  /**
   * 録音解析後のメロディ（音符の羅列）
   * @type {Array<{ startTime: number, endTime: number, midiNote: number }>}
   */
  let extractedNotes = [];

  /**
   * メジャースケールに最も近い MIDI ノートへスナップする。
   * @param {number} midi
   * @param {number} keyRoot 0–11（C=0）
   * @param {string} scaleType
   */
  function snapToScaleMidi(midi, keyRoot, scaleType) {
    if (scaleType !== "major" || keyRoot == null) {
      return Math.round(midi);
    }
    const rounded = Math.round(midi);
    const majorRel = [0, 2, 4, 5, 7, 9, 11];
    const allowed = new Set(
      majorRel.map(function (x) {
        return (x + keyRoot + 120) % 12;
      })
    );
    let best = rounded;
    let bestDist = Infinity;
    for (let d = -12; d <= 12; d++) {
      const candidate = rounded + d;
      const pc = ((candidate % 12) + 12) % 12;
      if (allowed.has(pc)) {
        const dist = Math.abs(midi - candidate);
        if (dist < bestDist) {
          bestDist = dist;
          best = candidate;
        }
      }
    }
    return best;
  }

  /**
   * メジャースケール上で snappedMidi から scaleSteps だけ上った MIDI ノート（ダイアトニック3度上は 2）。
   * @param {number} snappedMidi
   * @param {number} keyRoot
   * @param {number} scaleSteps
   */
  function stepsUpMajorScale(snappedMidi, keyRoot, scaleSteps) {
    const majorRel = [0, 2, 4, 5, 7, 9, 11];
    const allowed = new Set(
      majorRel.map(function (x) {
        return (x + keyRoot + 120) % 12;
      })
    );
    let m = snappedMidi;
    let remaining = scaleSteps;
    while (remaining > 0) {
      m += 1;
      const pc = ((m % 12) + 12) % 12;
      if (allowed.has(pc)) {
        remaining -= 1;
      }
    }
    return m;
  }

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
    const freqTC = 0.005;

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
  const songPresetEl = document.getElementById("songPreset");
  const currentSettingsEl = document.getElementById("currentSettings");

  let appAudioContext = null;
  /** オフライン解析用（録音ストリームには接続しない） */
  let offlineCrepeModel = null;
  let mediaStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordedObjectUrl = null;
  let harmonySynth = null;
  let micMonitorSource = null;
  let micMonitorGain = null;
  let harmonyPlaybackRafId = 0;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  /**
   * @param {number} midiIn 整数 MIDI
   * @returns {number}
   */
  function computeRawHarmonyMidi(midiIn) {
    const id = songPresetEl ? songPresetEl.value : "custom";
    if (id === "custom") {
      const intervalSemi = harmonyIntervalEl
        ? parseInt(harmonyIntervalEl.value, 10)
        : 7;
      const offsetSemi = Number.isNaN(intervalSemi) ? 7 : intervalSemi;
      return midiIn + offsetSemi;
    }
    const preset = SONG_PRESETS[id];
    if (!preset) {
      const intervalSemi = harmonyIntervalEl
        ? parseInt(harmonyIntervalEl.value, 10)
        : 7;
      return midiIn + (Number.isNaN(intervalSemi) ? 7 : intervalSemi);
    }
    if (
      preset.scaleType === "major" &&
      preset.harmonyType === "diatonic_3rd_up" &&
      preset.keyRoot != null
    ) {
      const snapped = snapToScaleMidi(midiIn, preset.keyRoot, "major");
      return stepsUpMajorScale(snapped, preset.keyRoot, 2);
    }
    if (preset.scaleType === "none" && preset.harmonyType === "parallel") {
      const intervalSemi =
        typeof preset.interval === "number" ? preset.interval : 7;
      return midiIn + intervalSemi;
    }
    return midiIn + 7;
  }

  function selectedHarmonyIntervalLabel() {
    if (!harmonyIntervalEl) {
      return "";
    }
    const opt = harmonyIntervalEl.options[harmonyIntervalEl.selectedIndex];
    return opt ? opt.textContent : "";
  }

  function updateCurrentSettingsDisplay() {
    if (!currentSettingsEl) {
      return;
    }
    const id = songPresetEl ? songPresetEl.value : "custom";
    if (id === "custom") {
      currentSettingsEl.textContent =
        "Key: — / Type: Custom（平行移動） — " +
        selectedHarmonyIntervalLabel();
      return;
    }
    const p = SONG_PRESETS[id];
    if (!p) {
      currentSettingsEl.textContent = "";
      return;
    }
    if (id === "cherry" && p.keyRoot != null) {
      const kn = NOTE_NAMES[((p.keyRoot % 12) + 12) % 12];
      currentSettingsEl.textContent =
        "Key: " + kn + " Major / Type: Diatonic 3rd Up";
      return;
    }
    if (id === "parallel_5th") {
      const n = typeof p.interval === "number" ? p.interval : 7;
      currentSettingsEl.textContent =
        "Key: — / Type: Parallel (+" + n + " semitones)";
      return;
    }
    currentSettingsEl.textContent = p.name;
  }

  function applySongPresetUi() {
    const custom = !songPresetEl || songPresetEl.value === "custom";
    if (harmonyIntervalEl) {
      harmonyIntervalEl.disabled = !custom;
    }
    updateCurrentSettingsDisplay();
  }

  function updateNoteCountReadout() {
    if (confidenceEl) {
      confidenceEl.textContent =
        extractedNotes.length > 0 ? String(extractedNotes.length) : "—";
    }
  }

  function clearLiveReadouts() {
    hzEl.textContent = "—";
    noteEl.textContent = "—";
    harmonyHzEl.textContent = "—";
    harmonyNoteEl.textContent = "—";
  }

  function stopHarmonyPlaybackLoop() {
    if (harmonyPlaybackRafId) {
      cancelAnimationFrame(harmonyPlaybackRafId);
      harmonyPlaybackRafId = 0;
    }
  }

  function disposeOfflineCrepeModel() {
    if (offlineCrepeModel && typeof offlineCrepeModel.dispose === "function") {
      try {
        offlineCrepeModel.dispose();
      } catch (e) {
        /* ignore */
      }
    }
    offlineCrepeModel = null;
  }

  async function ensureOfflineCrepeModel() {
    if (offlineCrepeModel) {
      return offlineCrepeModel;
    }
    if (typeof window.crepeLoadModelOnly !== "function") {
      throw new Error("crepe offline API が利用できません。");
    }
    offlineCrepeModel = await window.crepeLoadModelOnly(CREPE_MODEL_URL);
    return offlineCrepeModel;
  }

  /**
   * 生ピッチ列に移動平均（欠測は近傍の有効値のみで平均）
   * @param {Array<{ time: number, hz: number|null }>} frames
   */
  function smoothPitchMovingAverage(frames) {
    const half = Math.floor(PITCH_SMOOTH_WINDOW / 2);
    const out = [];
    for (let i = 0; i < frames.length; i++) {
      let sum = 0;
      let c = 0;
      for (let k = -half; k <= half; k++) {
        const j = i + k;
        if (j >= 0 && j < frames.length && frames[j].hz != null) {
          sum += frames[j].hz;
          c++;
        }
      }
      out.push({
        time: frames[i].time,
        hz: c > 0 ? sum / c : null,
      });
    }
    return out;
  }

  /**
   * 平滑化 → MIDI クオンタイズ
   * @param {Array<{ time: number, hz: number|null }>} frames
   */
  function framesToQuantizedMidi(frames) {
    return frames.map(function (f) {
      return {
        time: f.time,
        midi: f.hz != null ? Math.round(midiFromFrequency(f.hz)) : null,
      };
    });
  }

  /**
   * 同じ MIDI が続く区間を音符化し、短すぎる区間を除去
   * @param {Array<{ time: number, midi: number|null }>} frames
   * @param {number} hopSec
   */
  function segmentMidiFramesToNotes(frames, hopSec) {
    /** @type {Array<{ startTime: number, endTime: number, midiNote: number }>} */
    const notes = [];
    if (frames.length === 0) {
      return notes;
    }

    let i = 0;
    while (i < frames.length) {
      const m = frames[i].midi;
      let j = i + 1;
      while (j < frames.length && frames[j].midi === m) {
        j += 1;
      }
      const startTime = frames[i].time;
      const endTime =
        j < frames.length ? frames[j].time : frames[j - 1].time + hopSec;
      if (m != null && endTime - startTime >= MIN_NOTE_DURATION_SEC) {
        notes.push({
          startTime: startTime,
          endTime: endTime,
          midiNote: m,
        });
      }
      i = j;
    }
    return notes;
  }

  /**
   * Blob をデコードし CREPE でピッチ軌跡を取り、extractedNotes を更新する。
   * @param {Blob} blob
   */
  async function analyzeRecordingFromBlob(blob) {
    if (!window.crepeResampleFullTo16k || !window.crepePredictPitchFrame) {
      throw new Error("crepe offline モジュールが読み込まれていません。");
    }
    if (!appAudioContext) {
      throw new Error("AudioContext がありません。");
    }

    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await new Promise(function (resolve, reject) {
      appAudioContext.decodeAudioData(
        arrayBuffer.slice(0),
        resolve,
        reject
      );
    });

    const channel = audioBuffer.getChannelData(0);
    const data16k = window.crepeResampleFullTo16k(
      channel,
      audioBuffer.sampleRate
    );
    const hopSamples = Math.max(1, Math.round(16000 * ANALYSIS_HOP_SEC));
    const model = await ensureOfflineCrepeModel();
    const tf = window.ml5 && window.ml5.tf;

    /** @type {Array<{ time: number, hz: number|null, confidence: number }>} */
    const rawFrames = [];

    for (let start = 0; start < data16k.length; start += hopSamples) {
      const frame = new Float32Array(1024);
      const available = Math.min(1024, data16k.length - start);
      if (available <= 0) {
        break;
      }
      frame.set(data16k.subarray(start, start + available));
      const r = window.crepePredictPitchFrame(model, frame);
      rawFrames.push({
        time: start / 16000,
        hz: r.frequency,
        confidence: r.confidence,
      });
      if (tf && rawFrames.length % 8 === 0) {
        await tf.nextFrame();
      }
    }

    const smoothed = smoothPitchMovingAverage(rawFrames);
    const midiFrames = framesToQuantizedMidi(smoothed);
    extractedNotes = segmentMidiFramesToNotes(midiFrames, ANALYSIS_HOP_SEC);
    return true;
  }

  function findNoteAtTime(t) {
    for (let i = 0; i < extractedNotes.length; i++) {
      const n = extractedNotes[i];
      if (t >= n.startTime && t < n.endTime) {
        return n;
      }
    }
    return null;
  }

  function startHarmonyPlaybackLoop() {
    stopHarmonyPlaybackLoop();

    function tick() {
      harmonyPlaybackRafId = requestAnimationFrame(tick);
      if (!recordedAudio || recordedAudio.paused || recordedAudio.ended) {
        stopHarmonyPlaybackLoop();
        if (harmonySynth) {
          harmonySynth.silence();
        }
        clearLiveReadouts();
        return;
      }

      const t = recordedAudio.currentTime;
      const note = findNoteAtTime(t);
      if (note && harmonySynth) {
        const leadHz = frequencyFromMidi(note.midiNote);
        hzEl.textContent = leadHz.toFixed(1);
        noteEl.textContent = frequencyToNearestNote(leadHz);
        const harmonyMidi = computeRawHarmonyMidi(note.midiNote);
        const hz = frequencyFromMidi(harmonyMidi);
        harmonyHzEl.textContent = hz.toFixed(1);
        harmonyNoteEl.textContent = frequencyToNearestNote(hz);
        harmonySynth.setHarmonyHz(hz);
      } else {
        hzEl.textContent = "—";
        noteEl.textContent = "—";
        harmonyHzEl.textContent = "—";
        harmonyNoteEl.textContent = "—";
        if (harmonySynth) {
          harmonySynth.silence();
        }
      }
    }

    harmonyPlaybackRafId = requestAnimationFrame(tick);
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

  function startRecordingWithExistingStream() {
    if (!mediaStream || !mediaStream.active) {
      return;
    }
    if (mediaRecorder && mediaRecorder.state === "recording") {
      return;
    }
    extractedNotes = [];
    updateNoteCountReadout();
    playRecordedBtn.disabled = true;

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
      micRecordBtn.disabled = false;
      stopRecordBtn.disabled = true;
      setStatus("解析中...");
      analyzeRecordingFromBlob(blob)
        .then(function () {
          setStatus(
            "解析が完了しました。Play Recorded でハモリ付き再生できます。"
          );
          playRecordedBtn.disabled = false;
          updateNoteCountReadout();
        })
        .catch(function (e) {
          console.error(e);
          extractedNotes = [];
          setStatus(
            "解析に失敗しました: " + (e.message || String(e))
          );
          playRecordedBtn.disabled = false;
          updateNoteCountReadout();
        });
    };
    mediaRecorder.start();
    micRecordBtn.disabled = true;
    stopRecordBtn.disabled = false;
    setStatus("Recording…");
    clearLiveReadouts();
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
  }

  async function onMicRecordClick() {
    if (!window.ml5 || !ml5.tf) {
      setStatus("ml5.js（ml5.tf を含む）の読み込みに失敗しています。");
      return;
    }
    if (typeof window.crepeLoadModelOnly !== "function") {
      setStatus("crepe-pitch.js（オフライン API）が読み込まれていません。");
      return;
    }

    if (recordedAudio && !recordedAudio.paused) {
      recordedAudio.pause();
      recordedAudio.currentTime = 0;
    }
    stopHarmonyPlaybackLoop();
    if (harmonySynth) {
      harmonySynth.silence();
    }

    if (appAudioContext && mediaStream && mediaStream.active) {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        return;
      }
      if (micMonitorGain) {
        micMonitorGain.gain.value = 0.3;
      }
      micRecordBtn.disabled = true;
      startRecordingWithExistingStream();
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
    stopHarmonyPlaybackLoop();
    if (harmonySynth) {
      harmonySynth.silence();
    }
    if (micMonitorGain) {
      micMonitorGain.gain.value = 0;
    }
    recordedAudio.currentTime = 0;
    if (appAudioContext.state === "suspended") {
      appAudioContext.resume().catch(function (e) {
        console.error(e);
      });
    }
    setStatus("再生中（ハモリ付き）…");
    recordedAudio
      .play()
      .then(function () {
        startHarmonyPlaybackLoop();
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
    stopHarmonyPlaybackLoop();
    if (harmonySynth) {
      harmonySynth.silence();
    }
    if (micMonitorGain) {
      micMonitorGain.gain.value = 0.3;
    }
    clearLiveReadouts();
    setStatus("再生が終わりました。");
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

  if (songPresetEl) {
    songPresetEl.addEventListener("change", function () {
      applySongPresetUi();
    });
  }
  if (harmonyIntervalEl) {
    harmonyIntervalEl.addEventListener("change", function () {
      if (songPresetEl && songPresetEl.value === "custom") {
        updateCurrentSettingsDisplay();
      }
    });
  }
  applySongPresetUi();
  updateNoteCountReadout();

  window.addEventListener("beforeunload", function () {
    stopHarmonyPlaybackLoop();
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
    disposeOfflineCrepeModel();
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) {
        t.stop();
      });
    }
  });
})();
