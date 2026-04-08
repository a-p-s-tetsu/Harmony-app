(function () {
  "use strict";

  const CREPE_MODEL_URL =
    "https://cdn.jsdelivr.net/gh/ml5js/ml5-data-and-models@master/models/pitch-detection/crepe/";

  /** オフライン解析のホップ（秒）。10〜20ms 相当 */
  const ANALYSIS_HOP_SEC = 0.015;

  /** この未満の confidence は無音扱い（Float MIDI を null） */
  const PITCH_FRAME_CONFIDENCE_MIN = 0.5;

  /** モード量子化の半窓幅。前後7フレーム＝計15フレーム（約225ms @ 15ms hop） */
  const MODE_WINDOW_HALF = 7;

  /** これ未満の音符は隣接ノートにマージ（秒）。単独で無音に挟まれたものは削除 */
  const SHORT_NOTE_MERGE_SEC = 0.06;

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
    const releaseTC = 0.03;
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
  const playHarmonyOnlyBtn = document.getElementById("playHarmonyOnlyBtn");
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
   * Float MIDI 列に対し、各フレームで前後 MODE_WINDOW_HALF を含む窓内の
   * Math.round(floatMidi) の最頻値（モード）を整数 MIDI とする。窓内に有効値がなければ null。
   * @param {Array<{ time: number, floatMidi: number|null }>} frames
   * @param {number} halfWin
   */
  function modeQuantizeFloatMidiFrames(frames, halfWin) {
    const n = frames.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const counts = new Map();
      for (let k = -halfWin; k <= halfWin; k++) {
        const j = i + k;
        if (j < 0 || j >= n) {
          continue;
        }
        const fm = frames[j].floatMidi;
        if (fm == null) {
          continue;
        }
        const ri = Math.round(fm);
        counts.set(ri, (counts.get(ri) || 0) + 1);
      }
      if (counts.size === 0) {
        out.push({ time: frames[i].time, midi: null });
        continue;
      }
      let maxC = -1;
      const ties = [];
      counts.forEach(function (c, note) {
        if (c > maxC) {
          maxC = c;
          ties.length = 0;
          ties.push(note);
        } else if (c === maxC) {
          ties.push(note);
        }
      });
      ties.sort(function (a, b) {
        return a - b;
      });
      const modeMidi = ties[Math.floor(ties.length / 2)];
      out.push({ time: frames[i].time, midi: modeMidi });
    }
    return out;
  }

  /**
   * 整数 MIDI 列から連続同一音を音符化（無音フレームは区切り）
   * @param {Array<{ time: number, midi: number|null }>} frames
   * @param {number} hopSec
   * @returns {Array<{ startTime: number, endTime: number, midiNote: number }>}
   */
  function segmentQuantizedFramesToNotes(frames, hopSec) {
    const notes = [];
    let i = 0;
    while (i < frames.length) {
      const m = frames[i].midi;
      if (m == null) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < frames.length && frames[j].midi === m) {
        j += 1;
      }
      const startTime = frames[i].time;
      const endTime =
        j < frames.length ? frames[j].time : frames[j - 1].time + hopSec;
      notes.push({
        startTime: startTime,
        endTime: endTime,
        midiNote: m,
      });
      i = j;
    }
    return notes;
  }

  /**
   * 短い音符を削除せず隣接に吸収。前後が同音なら1つにマージ。
   * @param {Array<{ startTime: number, endTime: number, midiNote: number }>} notes
   * @param {number} minDurSec
   */
  function mergeShortNotesIntoNeighbors(notes, minDurSec) {
    const notesCopy = notes.map(function (n) {
      return {
        startTime: n.startTime,
        endTime: n.endTime,
        midiNote: n.midiNote,
      };
    });
    let guard = 0;
    const maxIter = Math.max(notesCopy.length * 3, 16);
    while (guard++ < maxIter) {
      const idx = notesCopy.findIndex(function (n) {
        return n.endTime - n.startTime < minDurSec;
      });
      if (idx < 0) {
        break;
      }
      const S = notesCopy[idx];
      const prev = idx > 0 ? notesCopy[idx - 1] : null;
      const next = idx < notesCopy.length - 1 ? notesCopy[idx + 1] : null;

      if (!prev && !next) {
        notesCopy.splice(idx, 1);
        continue;
      }
      if (!prev && next) {
        next.startTime = S.startTime;
        notesCopy.splice(idx, 1);
        continue;
      }
      if (prev && !next) {
        prev.endTime = S.endTime;
        notesCopy.splice(idx, 1);
        continue;
      }
      if (prev.midiNote === next.midiNote) {
        prev.endTime = next.endTime;
        notesCopy.splice(idx, 2);
        continue;
      }
      const dPrev = prev.endTime - prev.startTime;
      const dNext = next.endTime - next.startTime;
      if (dPrev >= dNext) {
        prev.endTime = S.endTime;
        notesCopy.splice(idx, 1);
      } else {
        next.startTime = S.startTime;
        notesCopy.splice(idx, 1);
      }
    }
    return notesCopy;
  }

  /**
   * CREPE raw フレームから安定した音符列へ（Float MIDI + モード量子化 + セグメント + 短音マージ）
   * @param {Array<{ time: number, hz: number|null, confidence: number }>} rawFrames
   * @param {number} hopSec
   * @returns {Array<{ startTime: number, endTime: number, midiNote: number }>}
   */
  function extractStableNotes(rawFrames, hopSec) {
    const floatFrames = rawFrames.map(function (f) {
      const ok =
        f.confidence >= PITCH_FRAME_CONFIDENCE_MIN &&
        f.hz != null &&
        f.hz > 0;
      return {
        time: f.time,
        floatMidi: ok ? midiFromFrequency(f.hz) : null,
      };
    });

    const modeFrames = modeQuantizeFloatMidiFrames(
      floatFrames,
      MODE_WINDOW_HALF
    );
    const segmented = segmentQuantizedFramesToNotes(modeFrames, hopSec);
    return mergeShortNotesIntoNeighbors(segmented, SHORT_NOTE_MERGE_SEC);
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

    extractedNotes = extractStableNotes(rawFrames, ANALYSIS_HOP_SEC);
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
    if (playHarmonyOnlyBtn) {
      playHarmonyOnlyBtn.disabled = true;
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
      micRecordBtn.disabled = false;
      stopRecordBtn.disabled = true;
      setStatus("解析中...");
      analyzeRecordingFromBlob(blob)
        .then(function () {
          setStatus(
            "解析が完了しました。Play Recorded または「ハモリのみ再生」で聞けます。"
          );
          playRecordedBtn.disabled = false;
          if (playHarmonyOnlyBtn) {
            playHarmonyOnlyBtn.disabled = false;
          }
          updateNoteCountReadout();
        })
        .catch(function (e) {
          console.error(e);
          extractedNotes = [];
          setStatus(
            "解析に失敗しました: " + (e.message || String(e))
          );
          playRecordedBtn.disabled = false;
          if (playHarmonyOnlyBtn) {
            playHarmonyOnlyBtn.disabled = false;
          }
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
      recordedAudio.muted = false;
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

  /**
   * 解析済みタイムラインに同期して再生。harmonyOnly 時は recordedAudio をミュートしハモリシンセのみ聞こえる。
   * @param {boolean} harmonyOnly
   */
  function startSyncedPlayback(harmonyOnly) {
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
    recordedAudio.muted = !!harmonyOnly;
    recordedAudio.currentTime = 0;
    if (appAudioContext.state === "suspended") {
      appAudioContext.resume().catch(function (e) {
        console.error(e);
      });
    }
    setStatus(
      harmonyOnly ? "再生中（ハモリのみ）…" : "再生中（ハモリ付き）…"
    );
    recordedAudio
      .play()
      .then(function () {
        startHarmonyPlaybackLoop();
      })
      .catch(function (e) {
        console.error(e);
        recordedAudio.muted = false;
        setStatus("再生を開始できませんでした。");
        if (micMonitorGain) {
          micMonitorGain.gain.value = 0.3;
        }
      });
  }

  function onPlayRecordedClick() {
    startSyncedPlayback(false);
  }

  function onPlayHarmonyOnlyClick() {
    startSyncedPlayback(true);
  }

  recordedAudio.addEventListener("ended", function () {
    stopHarmonyPlaybackLoop();
    recordedAudio.muted = false;
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

  if (playHarmonyOnlyBtn) {
    playHarmonyOnlyBtn.addEventListener("click", function () {
      onPlayHarmonyOnlyClick();
    });
  }

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
