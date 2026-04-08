/**
 * ml5.js 0.12.2 の PitchDetection（CREPE）実装と同じ推論パイプライン。
 * 著作権: ml5 (MIT) — https://github.com/ml5js/ml5-library
 *
 * 標準の ml5.pitchDetection は confidence > 0.5 のときだけ Hz を返すため、
 * マイク・部屋環境によっては常に「無音」と扱われることがあります。
 * しきい値は ml5 標準（0.5）よりやや緩いが、無音時の誤検出を抑える程度に留める。
 */
(function () {
  "use strict";

  /** これ未満は周波数 null（ノイズでハモリが鳴り続けるのを防ぐ） */
  var MIN_CONFIDENCE = 0.4;

  function getTf() {
    if (window.ml5 && window.ml5.tf) return window.ml5.tf;
    if (typeof window.tf !== "undefined") return window.tf;
    return null;
  }

  function resample(audioBuffer, onComplete) {
    var interpolate = audioBuffer.sampleRate % 16000 !== 0;
    var multiplier = audioBuffer.sampleRate / 16000;
    var original = audioBuffer.getChannelData(0);
    var subsamples = new Float32Array(1024);
    for (var i = 0; i < 1024; i += 1) {
      if (!interpolate) {
        subsamples[i] = original[i * multiplier];
      } else {
        var left = Math.floor(i * multiplier);
        var right = left + 1;
        var p = i * multiplier - left;
        subsamples[i] = (1 - p) * original[left] + p * original[right];
      }
    }
    onComplete(subsamples);
  }

  function CrepePitchDetection(modelPath, audioContext, stream, callback) {
    this.modelPath = modelPath;
    this.audioContext = audioContext;
    this.stream = stream;
    this.frequency = null;
    this.results = {};
    this.running = false;
    this.model = null;
    this._scriptNode = null;
    this._mic = null;
    this._gain = null;

    var self = this;
    this.ready = this._load(modelPath).then(
      function () {
        if (typeof callback === "function") callback();
        return self;
      },
      function (err) {
        if (typeof callback === "function") callback(err);
        throw err;
      }
    );
  }

  CrepePitchDetection.prototype._load = async function (modelPath) {
    var tf = getTf();
    if (!tf) {
      throw new Error("TensorFlow.js が見つかりません（ml5.js を先に読み込んでください）。");
    }
    await tf.ready();

    this.model = await tf.loadLayersModel(modelPath + "/model.json");
    await tf.nextFrame();
    await this._processStream();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    return this;
  };

  CrepePitchDetection.prototype._processStream = async function () {
    var tf = getTf();
    await tf.nextFrame();

    var mic = this.audioContext.createMediaStreamSource(this.stream);
    var minBufferSize = (this.audioContext.sampleRate / 16000) * 1024;
    var bufferSize = 4;
    while (bufferSize < minBufferSize) bufferSize *= 2;

    var scriptNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    var self = this;
    scriptNode.onaudioprocess = function (event) {
      self._onAudioProcess(event);
    };

    var gain = this.audioContext.createGain();
    gain.gain.setValueAtTime(0, this.audioContext.currentTime);

    mic.connect(scriptNode);
    scriptNode.connect(gain);
    gain.connect(this.audioContext.destination);

    this._mic = mic;
    this._scriptNode = scriptNode;
    this._gain = gain;

    if (this.audioContext.state !== "running") {
      console.warn(
        "AudioContext is not running; call audioContext.resume() after a user gesture."
      );
    }
  };

  CrepePitchDetection.prototype._onAudioProcess = async function (event) {
    var tf = getTf();
    await tf.nextFrame();

    var self = this;
    this.results = this.results || {};

    resample(event.inputBuffer, function (resampled) {
      tf.tidy(function () {
        var centMapping = tf.add(tf.linspace(0, 7180, 360), tf.tensor(1997.3794084376191));

        self.running = true;
        var frame = tf.tensor(resampled.slice(0, 1024));
        var zeromean = tf.sub(frame, tf.mean(frame));
        var framestd = tf.tensor(tf.norm(zeromean).dataSync()[0] / Math.sqrt(1024));
        var normalized = tf.div(zeromean, framestd);
        var input = normalized.reshape([1, 1024]);
        var activation = self.model.predict([input]).reshape([360]);
        var confidence = activation.max().dataSync()[0];
        var center = activation.argMax().dataSync()[0];

        self.results.confidence = confidence.toFixed(3);

        var start = Math.max(0, center - 4);
        var end = Math.min(360, center + 5);
        var weights = activation.slice([start], [end - start]);
        var cents = centMapping.slice([start], [end - start]);

        var products = tf.mul(weights, cents);
        var productSum = products.dataSync().reduce(function (a, b) {
          return a + b;
        }, 0);
        var weightSum = weights.dataSync().reduce(function (a, b) {
          return a + b;
        }, 0);
        var predictedCent = productSum / weightSum;
        var predictedHz = 10 * Math.pow(2, predictedCent / 1200.0);

        self.results.predictedHz = predictedHz;
        self.frequency = confidence > MIN_CONFIDENCE ? predictedHz : null;
      });
    });
  };

  CrepePitchDetection.prototype.getPitch = async function (callback) {
    await this.ready;
    var tf = getTf();
    await tf.nextFrame();
    var frequency = this.frequency;
    if (callback) {
      callback(undefined, frequency);
    }
    return frequency;
  };

  CrepePitchDetection.prototype.dispose = function () {
    try {
      if (this._scriptNode) {
        this._scriptNode.disconnect();
        this._scriptNode.onaudioprocess = null;
      }
      if (this._mic) this._mic.disconnect();
      if (this._gain) this._gain.disconnect();
    } catch (e) {
      /* ignore */
    }
    this._scriptNode = null;
    this._mic = null;
    this._gain = null;
    if (this.model && typeof this.model.dispose === "function") {
      this.model.dispose();
    }
    this.model = null;
  };

  /**
   * モノラル PCM を 16 kHz にリサンプル（CREPE は 1024 サンプル @ 16 kHz の窓を想定）。
   * @param {Float32Array} channelData
   * @param {number} sampleRate
   * @returns {Float32Array}
   */
  function resampleFullChannelTo16k(channelData, sampleRate) {
    var n = channelData.length;
    if (n === 0) {
      return new Float32Array(0);
    }
    var outLen = Math.ceil((n / sampleRate) * 16000);
    if (outLen < 1024) {
      outLen = 1024;
    }
    var out = new Float32Array(outLen);
    var sr = sampleRate;
    for (var i = 0; i < outLen; i++) {
      var srcPos = (i / 16000) * sr;
      var left = Math.floor(srcPos);
      if (left >= n - 1) {
        out[i] = channelData[n - 1];
      } else {
        var p = srcPos - left;
        out[i] = (1 - p) * channelData[left] + p * channelData[left + 1];
      }
    }
    return out;
  }

  /**
   * 学習済み CREPE モデルに 1024 サンプル（16 kHz）を渡して 1 フレーム推論する。
   * @param {*} model tf.LayersModel
   * @param {Float32Array} frame1024
   * @returns {{ frequency: number|null, confidence: number, predictedHz: number }}
   */
  function predictPitchFromFrame(model, frame1024) {
    var tf = getTf();
    if (!tf || !model) {
      return { frequency: null, confidence: 0, predictedHz: 0 };
    }
    var freq = null;
    var conf = 0;
    var predHz = 0;
    tf.tidy(function () {
      var centMapping = tf.add(tf.linspace(0, 7180, 360), tf.tensor(1997.3794084376191));
      var frame = tf.tensor(frame1024);
      var zeromean = tf.sub(frame, tf.mean(frame));
      var framestd = tf.tensor(tf.norm(zeromean).dataSync()[0] / Math.sqrt(1024));
      var normalized = tf.div(zeromean, framestd);
      var input = normalized.reshape([1, 1024]);
      var activation = model.predict([input]).reshape([360]);
      var confidence = activation.max().dataSync()[0];
      var center = activation.argMax().dataSync()[0];

      conf = confidence;

      var start = Math.max(0, center - 4);
      var end = Math.min(360, center + 5);
      var weights = activation.slice([start], [end - start]);
      var cents = centMapping.slice([start], [end - start]);

      var products = tf.mul(weights, cents);
      var productSum = products.dataSync().reduce(function (a, b) {
        return a + b;
      }, 0);
      var weightSum = weights.dataSync().reduce(function (a, b) {
        return a + b;
      }, 0);
      var predictedCent = productSum / weightSum;
      predHz = 10 * Math.pow(2, predictedCent / 1200.0);

      freq = confidence > MIN_CONFIDENCE ? predHz : null;
    });
    return { frequency: freq, confidence: conf, predictedHz: predHz };
  }

  /**
   * MediaStream なしでモデルだけ読み込む（オフライン解析用）。
   * @param {string} modelPath
   */
  async function loadCrepeModelOnly(modelPath) {
    var tf = getTf();
    if (!tf) {
      throw new Error("TensorFlow.js が見つかりません（ml5.js を先に読み込んでください）。");
    }
    await tf.ready();
    return await tf.loadLayersModel(modelPath + "/model.json");
  }

  window.crepeResampleFullTo16k = resampleFullChannelTo16k;
  window.crepePredictPitchFrame = predictPitchFromFrame;
  window.crepeLoadModelOnly = loadCrepeModelOnly;

  window.CrepePitchDetection = CrepePitchDetection;
})();
