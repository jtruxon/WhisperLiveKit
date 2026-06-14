const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL;
if (isExtension) {
  document.documentElement.classList.add('is-extension');
}
const isWebContext = !isExtension;

let isRecording = false;
let websocket = null;
let recorder = null;
let chunkDuration = 100;
let websocketUrl = "ws://localhost:8000/asr";
let userClosing = false;
let wakeLock = null;
let startTime = null;
let timerInterval = null;
let audioContext = null;
let analyser = null;
let microphone = null;
let workletNode = null;
let recorderWorker = null;
let waveCanvas = document.getElementById("waveCanvas");
let waveCtx = waveCanvas.getContext("2d");
let animationFrame = null;
let waitingForStop = false;
let lastReceivedData = null;
let lastSignature = null;
let availableMicrophones = [];
let selectedMicrophoneId = null;
let serverUseAudioWorklet = null;
let configReadyResolve;
const configReady = new Promise((r) => (configReadyResolve = r));
let outputAudioContext = null;
let audioSource = null;

// --- History & Audio Recording ---
let mp3EncoderWorker = null;
let pendingAudioSave = null;
let recordingStartTime = null;
let webmChunksForHistory = [];
let historyAudio = null;
let historyAnimFrame = null;
let currentHistoryDetailId = null;

// --- History Store (IndexedDB + localStorage) ---
const historyStore = {
  DB_NAME: 'WhisperLiveKitHistory',
  DB_VERSION: 1,
  STORE_NAME: 'audioBlobs',
  INDEX_KEY: 'wlk_history_index',
  db: null,

  async init() {
    try {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.STORE_NAME)) {
            db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
          }
        };
        request.onsuccess = (e) => {
          this.db = e.target.result;
          resolve();
        };
        request.onerror = (e) => {
          console.warn('IndexedDB open failed:', e);
          resolve(); // don't break app
        };
      });
    } catch (err) {
      console.warn('historyStore.init error:', err);
    }
  },

  async save(entry, blob) {
    try {
      // Save metadata to localStorage
      const index = this._getIndex();
      index.unshift(entry.id);
      localStorage.setItem(this.INDEX_KEY, JSON.stringify(index));
      localStorage.setItem('wlk_history_' + entry.id, JSON.stringify(entry));

      // Save audio blob to IndexedDB
      if (this.db && blob) {
        return new Promise((resolve) => {
          try {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.put({ id: entry.id, blob: blob });
            tx.oncomplete = () => resolve();
            tx.onerror = () => { console.warn('IDB save error'); resolve(); };
          } catch (err) {
            console.warn('IDB save error:', err);
            resolve();
          }
        });
      }
    } catch (err) {
      console.warn('historyStore.save error:', err);
    }
  },

  list() {
    try {
      const index = this._getIndex();
      const entries = [];
      for (const id of index) {
        const raw = localStorage.getItem('wlk_history_' + id);
        if (raw) {
          try { entries.push(JSON.parse(raw)); } catch (e) { /* skip corrupt */ }
        }
      }
      return entries;
    } catch (err) {
      console.warn('historyStore.list error:', err);
      return [];
    }
  },

  async getAudio(id) {
    if (!this.db) return null;
    try {
      return new Promise((resolve) => {
        const tx = this.db.transaction(this.STORE_NAME, 'readonly');
        const store = tx.objectStore(this.STORE_NAME);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror = () => resolve(null);
      });
    } catch (err) {
      console.warn('historyStore.getAudio error:', err);
      return null;
    }
  },

  async delete(id) {
    try {
      // Remove from localStorage
      const index = this._getIndex().filter(i => i !== id);
      localStorage.setItem(this.INDEX_KEY, JSON.stringify(index));
      localStorage.removeItem('wlk_history_' + id);

      // Remove from IndexedDB
      if (this.db) {
        return new Promise((resolve) => {
          try {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
          } catch (err) {
            resolve();
          }
        });
      }
    } catch (err) {
      console.warn('historyStore.delete error:', err);
    }
  },

  async clearAll() {
    try {
      const index = this._getIndex();
      for (const id of index) {
        localStorage.removeItem('wlk_history_' + id);
      }
      localStorage.removeItem(this.INDEX_KEY);

      if (this.db) {
        return new Promise((resolve) => {
          try {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
          } catch (err) {
            resolve();
          }
        });
      }
    } catch (err) {
      console.warn('historyStore.clearAll error:', err);
    }
  },

  _getIndex() {
    try {
      const raw = localStorage.getItem(this.INDEX_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }
};

waveCanvas.width = 60 * (window.devicePixelRatio || 1);
waveCanvas.height = 30 * (window.devicePixelRatio || 1);
waveCtx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

const statusText = document.getElementById("status");
const recordButton = document.getElementById("recordButton");
const chunkSelector = document.getElementById("chunkSelector");
const websocketInput = document.getElementById("websocketInput");
const websocketDefaultSpan = document.getElementById("wsDefaultUrl");
const linesTranscriptDiv = document.getElementById("linesTranscript");
const timerElement = document.querySelector(".timer");
const themeRadios = document.querySelectorAll('input[name="theme"]');
const microphoneSelect = document.getElementById("microphoneSelect");

const settingsToggle = document.getElementById("settingsToggle");
const settingsDiv = document.querySelector(".settings");
const copyButton = document.getElementById("copyTranscript");

// if (isExtension) {
//   chrome.runtime.onInstalled.addListener((details) => {
//     if (details.reason.search(/install/g) === -1) {
//       return;
//     }
//     chrome.tabs.create({
//       url: chrome.runtime.getURL("welcome.html"),
//       active: true
//     });
//   });
// }

const translationIcon = `<svg xmlns="http://www.w3.org/2000/svg" height="12px" viewBox="0 -960 960 960" width="12px" fill="#5f6368"><path d="m603-202-34 97q-4 11-14 18t-22 7q-20 0-32.5-16.5T496-133l152-402q5-11 15-18t22-7h30q12 0 22 7t15 18l152 403q8 19-4 35.5T868-80q-13 0-22.5-7T831-106l-34-96H603ZM362-401 188-228q-11 11-27.5 11.5T132-228q-11-11-11-28t11-28l174-174q-35-35-63.5-80T190-640h84q20 39 40 68t48 58q33-33 68.5-92.5T484-720H80q-17 0-28.5-11.5T40-760q0-17 11.5-28.5T80-800h240v-40q0-17 11.5-28.5T360-880q17 0 28.5 11.5T400-840v40h240q17 0 28.5 11.5T680-760q0 17-11.5 28.5T640-720h-76q-21 72-63 148t-83 116l96 98-30 82-122-125Zm266 129h144l-72-204-72 204Z"/></svg>`
const silenceIcon = `<svg xmlns="http://www.w3.org/2000/svg" style="vertical-align: text-bottom;" height="14px" viewBox="0 -960 960 960" width="14px" fill="#5f6368"><path d="M514-556 320-752q9-3 19-5.5t21-2.5q66 0 113 47t47 113q0 11-1.5 22t-4.5 22ZM40-200v-32q0-33 17-62t47-44q51-26 115-44t141-18q26 0 49.5 2.5T456-392l-56-54q-9 3-19 4.5t-21 1.5q-66 0-113-47t-47-113q0-11 1.5-21t4.5-19L84-764q-11-11-11-28t11-28q12-12 28.5-12t27.5 12l675 685q11 11 11.5 27.5T816-80q-11 13-28 12.5T759-80L641-200h39q0 33-23.5 56.5T600-120H120q-33 0-56.5-23.5T40-200Zm80 0h480v-32q0-14-4.5-19.5T580-266q-36-18-92.5-36T360-320q-71 0-127.5 18T140-266q-9 5-14.5 14t-5.5 20v32Zm240 0Zm560-400q0 69-24.5 131.5T829-355q-12 14-30 15t-32-13q-13-13-12-31t12-33q30-38 46.5-85t16.5-98q0-51-16.5-97T767-781q-12-15-12.5-33t12.5-32q13-14 31.5-13.5T829-845q42 51 66.5 113.5T920-600Zm-182 0q0 32-10 61.5T700-484q-11 15-29.5 15.5T638-482q-13-13-13.5-31.5T633-549q6-11 9.5-24t3.5-27q0-14-3.5-27t-9.5-25q-9-17-8.5-35t13.5-31q14-14 32.5-13.5T700-716q18 25 28 54.5t10 61.5Z"/></svg>`;
const languageIcon = `<svg xmlns="http://www.w3.org/2000/svg" height="12" viewBox="0 -960 960 960" width="12" fill="#5f6368"><path d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-155.5t86-127Q252-817 325-848.5T480-880q83 0 155.5 31.5t127 86q54.5 54.5 86 127T880-480q0 82-31.5 155t-86 127.5q-54.5 54.5-127 86T480-80Zm0-82q26-36 45-75t31-83H404q12 44 31 83t45 75Zm-104-16q-18-33-31.5-68.5T322-320H204q29 50 72.5 87t99.5 55Zm208 0q56-18 99.5-55t72.5-87H638q-9 38-22.5 73.5T584-178ZM170-400h136q-3-20-4.5-39.5T300-480q0-21 1.5-40.5T306-560H170q-5 20-7.5 39.5T160-480q0 21 2.5 40.5T170-400Zm216 0h188q3-20 4.5-39.5T580-480q0-21-1.5-40.5T574-560H386q-3 20-4.5 39.5T380-480q0 21 1.5 40.5T386-400Zm268 0h136q5-20 7.5-39.5T800-480q0-21-2.5-40.5T790-560H654q3 20 4.5 39.5T660-480q0 21-1.5 40.5T654-400Zm-16-240h118q-29-50-72.5-87T584-782q18 33 31.5 68.5T638-640Zm-234 0h152q-12-44-31-83t-45-75q-26 36-45 75t-31 83Zm-200 0h118q9-38 22.5-73.5T376-782q-56 18-99.5 55T204-640Z"/></svg>`
const speakerIcon = `<svg xmlns="http://www.w3.org/2000/svg" height="16px" style="vertical-align: text-bottom;" viewBox="0 -960 960 960" width="16px" fill="#5f6368"><path d="M480-480q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47ZM160-240v-32q0-34 17.5-62.5T224-378q62-31 126-46.5T480-440q66 0 130 15.5T736-378q29 15 46.5 43.5T800-272v32q0 33-23.5 56.5T720-160H240q-33 0-56.5-23.5T160-240Zm80 0h480v-32q0-11-5.5-20T700-306q-54-27-109-40.5T480-360q-56 0-111 13.5T260-306q-9 5-14.5 14t-5.5 20v32Zm240-320q33 0 56.5-23.5T560-640q0-33-23.5-56.5T480-720q-33 0-56.5 23.5T400-640q0 33 23.5 56.5T480-560Zm0-80Zm0 400Z"/></svg>`;

function getWaveStroke() {
  const styles = getComputedStyle(document.documentElement);
  const v = styles.getPropertyValue("--wave-stroke").trim();
  return v || "#000";
}

let waveStroke = getWaveStroke();
function updateWaveStroke() {
  waveStroke = getWaveStroke();
}

function applyTheme(pref) {
  if (pref === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else if (pref === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  updateWaveStroke();
}

// Persisted theme preference
const savedThemePref = localStorage.getItem("themePreference") || "system";
applyTheme(savedThemePref);
if (themeRadios.length) {
  themeRadios.forEach((r) => {
    r.checked = r.value === savedThemePref;
    r.addEventListener("change", () => {
      if (r.checked) {
        localStorage.setItem("themePreference", r.value);
        applyTheme(r.value);
      }
    });
  });
}

// React to OS theme changes when in "system" mode
const darkMq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
const handleOsThemeChange = () => {
  const pref = localStorage.getItem("themePreference") || "system";
  if (pref === "system") updateWaveStroke();
};
if (darkMq && darkMq.addEventListener) {
  darkMq.addEventListener("change", handleOsThemeChange);
} else if (darkMq && darkMq.addListener) {
  // deprecated, but included for Safari compatibility
  darkMq.addListener(handleOsThemeChange);
}

async function enumerateMicrophones() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    availableMicrophones = devices.filter(device => device.kind === 'audioinput');

    populateMicrophoneSelect();
    console.log(`Found ${availableMicrophones.length} microphone(s)`);
  } catch (error) {
    console.error('Error enumerating microphones:', error);
    statusText.textContent = "Error accessing microphones. Please grant permission.";
  }
}

function populateMicrophoneSelect() {
  if (!microphoneSelect) return;

  microphoneSelect.innerHTML = '<option value="">Default Microphone</option>';

  availableMicrophones.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    microphoneSelect.appendChild(option);
  });

  const savedMicId = localStorage.getItem('selectedMicrophone');
  if (savedMicId && availableMicrophones.some(mic => mic.deviceId === savedMicId)) {
    microphoneSelect.value = savedMicId;
    selectedMicrophoneId = savedMicId;
  }
}

function handleMicrophoneChange() {
  selectedMicrophoneId = microphoneSelect.value || null;
  localStorage.setItem('selectedMicrophone', selectedMicrophoneId || '');

  const selectedDevice = availableMicrophones.find(mic => mic.deviceId === selectedMicrophoneId);
  const deviceName = selectedDevice ? selectedDevice.label : 'Default Microphone';

  console.log(`Selected microphone: ${deviceName}`);
  statusText.textContent = `Microphone changed to: ${deviceName}`;

  if (isRecording) {
    statusText.textContent = "Switching microphone... Please wait.";
    stopRecording().then(() => {
      setTimeout(() => {
        toggleRecording();
      }, 1000);
    });
  }
}

// Helpers
function fmt1(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(1) : x;
}

let host, port, protocol;
port = 8000;
if (isExtension) {
    host = "localhost";
    protocol = "ws";
} else {
    host = window.location.hostname || "localhost";
    port = window.location.port;
    protocol = window.location.protocol === "https:" ? "wss" : "ws";
}
const defaultWebSocketUrl = `${protocol}://${host}${port ? ":" + port : ""}/asr`;

// Populate default caption and input
if (websocketDefaultSpan) websocketDefaultSpan.textContent = defaultWebSocketUrl;
websocketInput.value = defaultWebSocketUrl;
websocketUrl = defaultWebSocketUrl;

// Optional chunk selector (guard for presence)
if (chunkSelector) {
  chunkSelector.addEventListener("change", () => {
    chunkDuration = parseInt(chunkSelector.value);
  });
}

// WebSocket input change handling
websocketInput.addEventListener("change", () => {
  const urlValue = websocketInput.value.trim();
  if (!urlValue.startsWith("ws://") && !urlValue.startsWith("wss://")) {
    statusText.textContent = "Invalid WebSocket URL (must start with ws:// or wss://)";
    return;
  }
  websocketUrl = urlValue;
  statusText.textContent = "WebSocket URL updated. Ready to connect.";
});

function setupWebSocket() {
  return new Promise((resolve, reject) => {
    try {
      websocket = new WebSocket(websocketUrl);
    } catch (error) {
      statusText.textContent = "Invalid WebSocket URL. Please check and try again.";
      reject(error);
      return;
    }

    websocket.onopen = () => {
      statusText.textContent = "Connected to server.";
      resolve();
    };

    websocket.onclose = () => {
      if (userClosing) {
        if (waitingForStop) {
          statusText.textContent = "Processing finalized or connection closed.";
          if (lastReceivedData) {
          renderLinesWithBuffer(
              lastReceivedData.lines || [],
              lastReceivedData.buffer_diarization || "",
              lastReceivedData.buffer_transcription || "",
              lastReceivedData.buffer_translation || "",
              0,
              0,
              true
            );
          }
          if (linesTranscriptDiv.innerText.trim().length > 0) {
            copyButton.style.display = "";
          }
          // Save to history (fallback if ready_to_stop wasn't received)
          saveRecordingToHistory();
        }
      } else {
        statusText.textContent = "Disconnected from the WebSocket server. (Check logs if model is loading.)";
        if (isRecording) {
          stopRecording();
        }
      }
      isRecording = false;
      waitingForStop = false;
      userClosing = false;
      lastReceivedData = null;
      websocket = null;
      updateUI();
    };

    websocket.onerror = () => {
      statusText.textContent = "Error connecting to WebSocket.";
      reject(new Error("Error connecting to WebSocket"));
    };

    websocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "config") {
        serverUseAudioWorklet = !!data.useAudioWorklet;
        statusText.textContent = serverUseAudioWorklet
          ? "Connected. Using AudioWorklet (PCM)."
          : "Connected. Using MediaRecorder (WebM).";
        if (configReadyResolve) configReadyResolve();
        return;
      }

      // Ignore diff/snapshot messages — the default frontend uses full-state mode.
      // These are only sent when a client explicitly opts in via ?mode=diff.
      if (data.type === "diff" || data.type === "snapshot") {
        console.warn("Received diff-protocol message but frontend is in full mode; ignoring.", data.type);
        return;
      }

      if (data.type === "ready_to_stop") {
        console.log("Ready to stop received, finalizing display and closing WebSocket.");
        waitingForStop = false;

        if (lastReceivedData) {
          renderLinesWithBuffer(
            lastReceivedData.lines || [],
            lastReceivedData.buffer_diarization || "",
            lastReceivedData.buffer_transcription || "",
            lastReceivedData.buffer_translation || "",
            0,
            0,
            true
          );
        }
        statusText.textContent = "Finished processing audio! Ready to record again.";
        recordButton.disabled = false;
        if (linesTranscriptDiv.innerText.trim().length > 0) {
          copyButton.style.display = "";
        }

        // --- Save to history ---
        saveRecordingToHistory();

        if (websocket) {
          websocket.close();
        }
        return;
      }

      lastReceivedData = data;

      const {
        lines = [],
        buffer_transcription = "",
        buffer_diarization = "",
        buffer_translation = "",
        remaining_time_transcription = 0,
        remaining_time_diarization = 0,
        status = "active_transcription",
      } = data;

      renderLinesWithBuffer(
        lines,
        buffer_diarization,
        buffer_transcription,
        buffer_translation,
        remaining_time_diarization,
        remaining_time_transcription,
        false,
        status
      );
    };
  });
}

function renderLinesWithBuffer(
  lines,
  buffer_diarization,
  buffer_transcription,
  buffer_translation,
  remaining_time_diarization,
  remaining_time_transcription,
  isFinalizing = false,
  current_status = "active_transcription"
) {
  if (current_status === "no_audio_detected") {
    linesTranscriptDiv.innerHTML =
      "<p style='text-align: center; color: var(--muted); margin-top: 20px;'><em>No audio detected...</em></p>";
    return;
  }

  const showLoading = !isFinalizing && (lines || []).some((it) => it.speaker == 0);
  const showTransLag = !isFinalizing && remaining_time_transcription > 0;
  const showDiaLag = !isFinalizing && !!buffer_diarization && remaining_time_diarization > 0;
  const signature = JSON.stringify({
    lines: (lines || []).map((it) => ({ speaker: it.speaker, text: it.text, start: it.start, end: it.end, detected_language: it.detected_language })),
    buffer_transcription: buffer_transcription || "",
    buffer_diarization: buffer_diarization || "",
    buffer_translation: buffer_translation,
    status: current_status,
    showLoading,
    showTransLag,
    showDiaLag,
    isFinalizing: !!isFinalizing,
  });
  if (lastSignature === signature) {
    const t = document.querySelector(".lag-transcription-value");
    if (t) t.textContent = fmt1(remaining_time_transcription);
    const d = document.querySelector(".lag-diarization-value");
    if (d) d.textContent = fmt1(remaining_time_diarization);
    const ld = document.querySelector(".loading-diarization-value");
    if (ld) ld.textContent = fmt1(remaining_time_diarization);
    return;
  }
  lastSignature = signature;

  // When there are no committed lines yet but buffer text exists (common with
  // slow backends like voxtral on MPS), render the buffer as a standalone line.
  const effectiveLines = (lines || []).length === 0 && (buffer_transcription || buffer_diarization)
    ? [{ speaker: 1, text: "" }]
    : (lines || []);

  const linesHtml = effectiveLines
    .map((item, idx) => {
      let timeInfo = "";
      if (item.start !== undefined && item.end !== undefined) {
        timeInfo = ` ${item.start} - ${item.end}`;
      }

      let speakerLabel = "";
      if (item.speaker === -2) {
        speakerLabel = `<span class="silence">${silenceIcon}<span id='timeInfo'>${timeInfo}</span></span>`;
      } else if (item.speaker == 0 && !isFinalizing) {
        speakerLabel = `<span class='loading'><span class="spinner"></span><span id='timeInfo'><span class="loading-diarization-value">${fmt1(
          remaining_time_diarization
        )}</span> second(s) of audio are undergoing diarization</span></span>`;
      } else if (item.speaker !== 0) {
        const speakerNum = `<span class="speaker-badge">${item.speaker}</span>`;
        speakerLabel = `<span id="speaker">${speakerIcon}${speakerNum}<span id='timeInfo'>${timeInfo}</span></span>`;

        if (item.detected_language) {
          speakerLabel += `<span class="label_language">${languageIcon}<span>${item.detected_language}</span></span>`;
        }
      }

      let currentLineText = item.text || "";

      if (idx === effectiveLines.length - 1) {
        if (!isFinalizing && item.speaker !== -2) {
            speakerLabel += `<span class="label_transcription"><span class="spinner"></span>Transcription lag <span id='timeInfo'><span class="lag-transcription-value">${fmt1(
              remaining_time_transcription
            )}</span>s</span></span>`;

          if (buffer_diarization && remaining_time_diarization) {
            speakerLabel += `<span class="label_diarization"><span class="spinner"></span>Diarization lag<span id='timeInfo'><span class="lag-diarization-value">${fmt1(
              remaining_time_diarization
            )}</span>s</span></span>`;
          }
        }

        if (buffer_diarization) {
          if (isFinalizing) {
            currentLineText +=
              (currentLineText.length > 0 && buffer_diarization.trim().length > 0 ? " " : "") + buffer_diarization.trim();
          } else {
            currentLineText += `<span class="buffer_diarization">${buffer_diarization}</span>`;
          }
        }
        if (buffer_transcription) {
          if (isFinalizing) {
            currentLineText +=
              (currentLineText.length > 0 && buffer_transcription.trim().length > 0 ? " " : "") +
              buffer_transcription.trim();
          } else {
            currentLineText += `<span class="buffer_transcription">${buffer_transcription}</span>`;
          }
        }
      }
      let translationContent = "";
      if (item.translation) {
        translationContent += item.translation.trim();
      }
      if (idx === effectiveLines.length - 1 && buffer_translation) {
        const bufferPiece = isFinalizing
          ? buffer_translation
          : `<span class="buffer_translation">${buffer_translation}</span>`;
        translationContent += translationContent ? `${bufferPiece}` : bufferPiece;
      }
      if (translationContent.trim().length > 0) {
        currentLineText += `
            <div>
                <div class="label_translation">
                    ${translationIcon}
                    <span class="translation_text">${translationContent}</span>
                </div>
            </div>`;
      }

      return currentLineText.trim().length > 0 || speakerLabel.length > 0
        ? `<p>${speakerLabel}<br/><div class='textcontent'>${currentLineText}</div></p>`
        : `<p>${speakerLabel}<br/></p>`;
    })
    .join("");

  linesTranscriptDiv.innerHTML = linesHtml;
  const transcriptContainer = document.querySelector('.transcript-container');
  if (transcriptContainer) {
    transcriptContainer.scrollTo({ top: transcriptContainer.scrollHeight, behavior: "smooth" });
  }
}

function updateTimer() {
  if (!startTime) return;

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const seconds = (elapsed % 60).toString().padStart(2, "0");
  timerElement.textContent = `${minutes}:${seconds}`;
}

function drawWaveform() {
  if (!analyser) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyser.getByteTimeDomainData(dataArray);

  waveCtx.clearRect(
    0,
    0,
    waveCanvas.width / (window.devicePixelRatio || 1),
    waveCanvas.height / (window.devicePixelRatio || 1)
  );
  waveCtx.lineWidth = 1;
  waveCtx.strokeStyle = waveStroke;
  waveCtx.beginPath();

  const sliceWidth = (waveCanvas.width / (window.devicePixelRatio || 1)) / bufferLength;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 128.0;
    const y = (v * (waveCanvas.height / (window.devicePixelRatio || 1))) / 2;

    if (i === 0) {
      waveCtx.moveTo(x, y);
    } else {
      waveCtx.lineTo(x, y);
    }

    x += sliceWidth;
  }

  waveCtx.lineTo(
    waveCanvas.width / (window.devicePixelRatio || 1),
    (waveCanvas.height / (window.devicePixelRatio || 1)) / 2
  );
  waveCtx.stroke();

  animationFrame = requestAnimationFrame(drawWaveform);
}

async function startRecording() {
  try {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch (err) {
      console.log("Error acquiring wake lock.");
    }

    let stream;
    
    // chromium extension. in the future, both chrome page audio and mic will be used
    if (isExtension) {
      try {
        stream = await new Promise((resolve, reject) => {
          chrome.tabCapture.capture({audio: true}, (s) => {
            if (s) {
              resolve(s);
            } else {
              reject(new Error('Tab capture failed or not available'));
            }
          });
        });
        
        try {
          outputAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          audioSource = outputAudioContext.createMediaStreamSource(stream);
          audioSource.connect(outputAudioContext.destination);
        } catch (audioError) {
          console.warn('could not preserve system audio:', audioError);
        }
        
        statusText.textContent = "Using tab audio capture.";
      } catch (tabError) {
        console.log('Tab capture not available, falling back to microphone', tabError);
        const audioConstraints = selectedMicrophoneId
          ? { audio: { deviceId: { exact: selectedMicrophoneId } } }
          : { audio: true };
        stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
        statusText.textContent = "Using microphone audio.";
      }
    } else if (isWebContext) {
      const audioConstraints = selectedMicrophoneId 
        ? { audio: { deviceId: { exact: selectedMicrophoneId } } }
        : { audio: true };
      stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);

    // Initialize MP3/WAV encoder worker for history recording
    try {
      mp3EncoderWorker = new Worker("/web/mp3_encoder_worker.js");
      mp3EncoderWorker.postMessage({ command: 'init', sampleRate: audioContext.sampleRate });
    } catch (encErr) {
      console.warn('Could not initialize encoder worker:', encErr);
      mp3EncoderWorker = null;
    }

    if (serverUseAudioWorklet) {
      if (!audioContext.audioWorklet) {
        throw new Error("AudioWorklet is not supported in this browser");
      }
      await audioContext.audioWorklet.addModule("/web/pcm_worklet.js");
      workletNode = new AudioWorkletNode(audioContext, "pcm-forwarder", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      microphone.connect(workletNode);

      recorderWorker = new Worker("/web/recorder_worker.js");
      recorderWorker.postMessage({
        command: "init",
        config: {
          sampleRate: audioContext.sampleRate,
        },
      });

      recorderWorker.onmessage = (e) => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          websocket.send(e.data.buffer);
        }
      };

      workletNode.port.onmessage = (e) => {
        const data = e.data;
        const ab = data instanceof ArrayBuffer ? data : data.buffer;

        // Fork: copy buffer for WAV encoding (before transfer neuters it)
        if (mp3EncoderWorker) {
          const copy = ab.slice(0);
          mp3EncoderWorker.postMessage({ command: 'encode', buffer: copy }, [copy]);
        }

        recorderWorker.postMessage(
          {
            command: "record",
            buffer: ab,
          },
          [ab]
        );
      };
    } else {
      try {
        recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      } catch (e) {
        recorder = new MediaRecorder(stream);
      }

      // Collect WebM chunks for history (MediaRecorder path)
      webmChunksForHistory = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          // Fork: collect chunks for history
          webmChunksForHistory.push(e.data.slice(0));

          if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(e.data);
          }
        }
      };
      recorder.start(chunkDuration);
    }

    recordingStartTime = Date.now();
    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);
    drawWaveform();

    isRecording = true;
    updateUI();
  } catch (err) {
    if (window.location.hostname === "0.0.0.0") {
      statusText.textContent =
        "Error accessing microphone. Browsers may block microphone access on 0.0.0.0. Try using localhost:8000 instead.";
    } else {
      statusText.textContent = "Error accessing microphone. Please allow microphone access.";
    }
    console.error(err);
  }
}

async function stopRecording() {
  // Capture recording duration before resetting startTime
  const recordingDuration = recordingStartTime
    ? Math.floor((Date.now() - recordingStartTime) / 1000)
    : 0;

  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch (e) {
      // ignore
    }
    wakeLock = null;
  }

  userClosing = true;
  waitingForStop = true;

  if (websocket && websocket.readyState === WebSocket.OPEN) {
    const emptyBlob = new Blob([], { type: "audio/webm" });
    websocket.send(emptyBlob);
    statusText.textContent = "Recording stopped. Processing final audio...";
  }

  // Flush the encoder worker for AudioWorklet path
  if (mp3EncoderWorker && serverUseAudioWorklet) {
    pendingAudioSave = new Promise((resolve) => {
      mp3EncoderWorker.onmessage = (ev) => {
        if (ev.data && ev.data.type === 'mp3') {
          resolve({ blob: ev.data.blob, duration: recordingDuration });
        }
      };
      mp3EncoderWorker.postMessage({ command: 'flush' });
    });
  }

  // For MediaRecorder path, store WebM chunks directly
  if (!serverUseAudioWorklet && webmChunksForHistory.length > 0) {
    const webmBlob = new Blob(webmChunksForHistory, { type: 'audio/webm' });
    pendingAudioSave = Promise.resolve({ blob: webmBlob, duration: recordingDuration });
    webmChunksForHistory = [];
  }

  if (recorder) {
    try {
      recorder.stop();
    } catch (e) {
    }
    recorder = null;
  }

  if (recorderWorker) {
    recorderWorker.terminate();
    recorderWorker = null;
  }
  
  if (workletNode) {
    try {
      workletNode.port.onmessage = null;
    } catch (e) {}
    try {
      workletNode.disconnect();
    } catch (e) {}
    workletNode = null;
  }

  if (microphone) {
    microphone.disconnect();
    microphone = null;
  }

  if (analyser) {
    analyser = null;
  }

  if (audioContext && audioContext.state !== "closed") {
    try {
      await audioContext.close();
    } catch (e) {
      console.warn("Could not close audio context:", e);
    }
    audioContext = null;
  }

  if (audioSource) {
    audioSource.disconnect();
    audioSource = null;
  }

  if (outputAudioContext && outputAudioContext.state !== "closed") {
    outputAudioContext.close()
    outputAudioContext = null;
  }

  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerElement.textContent = "00:00";
  startTime = null;
  recordingStartTime = null;

  isRecording = false;
  updateUI();
}

// --- Save Recording to History ---
async function saveRecordingToHistory() {
  try {
    if (!pendingAudioSave) return;

    const { blob, duration } = await pendingAudioSave;
    pendingAudioSave = null;

    // Don't save if no transcript content
    const plainText = linesTranscriptDiv ? linesTranscriptDiv.innerText.trim() : '';
    if (!plainText && !blob) return;

    const now = Date.now();
    const id = 'rec_' + now + '_' + Math.random().toString(16).slice(2, 6);
    const dateStr = new Date(now).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });

    const entry = {
      id: id,
      createdAt: now,
      duration: duration || 0,
      title: 'Recording — ' + dateStr,
      plainText: plainText,
      lines: lastReceivedData ? (lastReceivedData.lines || []) : [],
      audioRef: id
    };

    await historyStore.save(entry, blob);
    console.log('Recording saved to history:', id);

    // Clean up encoder worker
    if (mp3EncoderWorker) {
      mp3EncoderWorker.terminate();
      mp3EncoderWorker = null;
    }

    // Update history panel if open
    if (document.getElementById('historyPanel').classList.contains('visible')) {
      renderHistoryList();
    }
  } catch (err) {
    console.warn('Failed to save recording to history:', err);
    if (mp3EncoderWorker) {
      mp3EncoderWorker.terminate();
      mp3EncoderWorker = null;
    }
  }
}

async function toggleRecording() {
  if (!isRecording) {
    copyButton.style.display = "none";
    if (waitingForStop) {
      console.log("Waiting for stop, early return");
      return;
    }
    console.log("Connecting to WebSocket");
    try {
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        await configReady;
        await startRecording();
      } else {
        await setupWebSocket();
        await configReady;
        await startRecording();
      }
    } catch (err) {
      statusText.textContent = "Could not connect to WebSocket or access mic. Aborted.";
      console.error(err);
    }
  } else {
    console.log("Stopping recording");
    stopRecording();
  }
}

function updateUI() {
  recordButton.classList.toggle("recording", isRecording);
  recordButton.disabled = waitingForStop;

  if (waitingForStop) {
    if (statusText.textContent !== "Recording stopped. Processing final audio...") {
      statusText.textContent = "Please wait for processing to complete...";
    }
  } else if (isRecording) {
    statusText.textContent = "";
  } else {
    if (
      statusText.textContent !== "Finished processing audio! Ready to record again." &&
      statusText.textContent !== "Processing finalized or connection closed."
    ) {
      statusText.textContent = "Click to start transcription";
    }
  }
  if (!waitingForStop) {
    recordButton.disabled = false;
  }
}

recordButton.addEventListener("click", toggleRecording);

if (microphoneSelect) {
  microphoneSelect.addEventListener("change", handleMicrophoneChange);
}
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await enumerateMicrophones();
  } catch (error) {
    console.log("Could not enumerate microphones on load:", error);
  }
  // Initialize history store
  try {
    await historyStore.init();
  } catch (error) {
    console.log("Could not initialize history store:", error);
  }
  // Set up history panel event listeners
  initHistoryPanel();
});
navigator.mediaDevices.addEventListener('devicechange', async () => {
  console.log('Device change detected, re-enumerating microphones');
  try {
    await enumerateMicrophones();
  } catch (error) {
    console.log("Error re-enumerating microphones:", error);
  }
});


settingsToggle.addEventListener("click", () => {
settingsDiv.classList.toggle("visible");
settingsToggle.classList.toggle("active");
});

copyButton.addEventListener("click", async () => {
  const textContent = linesTranscriptDiv.innerText.trim();
  if (!textContent) return;
  try {
    await navigator.clipboard.writeText(textContent);
    copyButton.title = "Copied!";
    copyButton.classList.add("copied");
    setTimeout(() => {
      copyButton.title = "Copy transcript to clipboard";
      copyButton.classList.remove("copied");
    }, 2000);
  } catch (err) {
    console.error("Failed to copy transcript:", err);
  }
});

if (isExtension) {
  async function checkAndRequestPermissions() {
    const micPermission = await navigator.permissions.query({
      name: "microphone",
    });

    const permissionDisplay = document.getElementById("audioPermission");
    if (permissionDisplay) {
      permissionDisplay.innerText = `MICROPHONE: ${micPermission.state}`;
    }

    // if (micPermission.state !== "granted") {
    //   chrome.tabs.create({ url: "welcome.html" });
    // }

    const intervalId = setInterval(async () => {
      const micPermission = await navigator.permissions.query({
        name: "microphone",
      });
      if (micPermission.state === "granted") {
        if (permissionDisplay) {
          permissionDisplay.innerText = `MICROPHONE: ${micPermission.state}`;
        }
        clearInterval(intervalId);
      }
    }, 100);
  }

  void checkAndRequestPermissions();
}

// ===== History Panel UI Logic =====

function initHistoryPanel() {
  const historyToggle = document.getElementById('historyToggle');
  const historyBack = document.getElementById('historyBack');
  const historyClearAll = document.getElementById('historyClearAll');
  const historyDetailBack = document.getElementById('historyDetailBack');
  const historyDetailCopy = document.getElementById('historyDetailCopy');
  const historyDetailDelete = document.getElementById('historyDetailDelete');
  const historyPlayBtn = document.getElementById('historyPlayBtn');
  const historySeekBar = document.getElementById('historySeekBar');

  if (historyToggle) {
    historyToggle.addEventListener('click', toggleHistoryPanel);
  }
  if (historyBack) {
    historyBack.addEventListener('click', closeHistoryPanel);
  }
  if (historyClearAll) {
    historyClearAll.addEventListener('click', clearAllHistory);
  }
  if (historyDetailBack) {
    historyDetailBack.addEventListener('click', closeHistoryDetail);
  }
  if (historyDetailCopy) {
    historyDetailCopy.addEventListener('click', () => {
      const entry = getHistoryEntry(currentHistoryDetailId);
      if (entry) {
        copyHistoryText(entry.plainText, historyDetailCopy);
      }
    });
  }
  if (historyDetailDelete) {
    historyDetailDelete.addEventListener('click', () => {
      if (currentHistoryDetailId) {
        deleteHistoryEntry(currentHistoryDetailId);
      }
    });
  }
  if (historyPlayBtn) {
    historyPlayBtn.addEventListener('click', toggleHistoryPlayback);
  }
  if (historySeekBar) {
    historySeekBar.addEventListener('input', (e) => {
      seekHistoryAudio(parseFloat(e.target.value));
    });
  }
}

function toggleHistoryPanel() {
  const panel = document.getElementById('historyPanel');
  const toggle = document.getElementById('historyToggle');
  if (!panel) return;

  const isVisible = panel.classList.contains('visible');
  if (isVisible) {
    closeHistoryPanel();
  } else {
    panel.classList.add('visible');
    if (toggle) toggle.classList.add('active');
    renderHistoryList();
  }
}

function closeHistoryPanel() {
  const panel = document.getElementById('historyPanel');
  const toggle = document.getElementById('historyToggle');
  const detail = document.getElementById('historyDetail');

  if (detail) detail.classList.remove('visible');
  if (panel) panel.classList.remove('visible');
  if (toggle) toggle.classList.remove('active');

  stopHistoryPlayback();
  currentHistoryDetailId = null;
}

function renderHistoryList() {
  const listEl = document.getElementById('historyList');
  const emptyEl = document.querySelector('.history-empty');
  if (!listEl) return;

  const entries = historyStore.list();

  if (entries.length === 0) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.add('visible');
    return;
  }

  if (emptyEl) emptyEl.classList.remove('visible');

  listEl.innerHTML = entries.map(entry => {
    const dateStr = new Date(entry.createdAt).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    const durMin = Math.floor((entry.duration || 0) / 60);
    const durSec = (entry.duration || 0) % 60;
    const durStr = durMin + ':' + durSec.toString().padStart(2, '0');
    const preview = (entry.plainText || '').substring(0, 120) || 'No transcript';

    return `<div class="history-item" data-id="${entry.id}">
      <div class="history-item-header">
        <span class="history-item-title">${escapeHtml(entry.title || dateStr)}</span>
        <span class="history-item-duration">${durStr}</span>
      </div>
      <div class="history-item-preview">${escapeHtml(preview)}</div>
      <div class="history-item-actions">
        <button class="history-item-btn history-item-copy" title="Copy transcript" data-id="${entry.id}">
          <img src="src/clipboard.svg" alt="Copy" width="16" height="16" />
        </button>
        <button class="history-item-btn history-item-delete" title="Delete" data-id="${entry.id}">
          <img src="src/trash.svg" alt="Delete" width="16" height="16" />
        </button>
      </div>
    </div>`;
  }).join('');

  // Attach event listeners
  listEl.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't open detail if clicking action buttons
      if (e.target.closest('.history-item-btn')) return;
      openHistoryDetail(item.dataset.id);
    });
  });

  listEl.querySelectorAll('.history-item-copy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const entry = getHistoryEntry(id);
      if (entry) {
        copyHistoryText(entry.plainText, btn);
      }
    });
  });

  listEl.querySelectorAll('.history-item-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryEntry(btn.dataset.id);
    });
  });
}

function getHistoryEntry(id) {
  try {
    const raw = localStorage.getItem('wlk_history_' + id);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function openHistoryDetail(id) {
  const detail = document.getElementById('historyDetail');
  const titleEl = document.getElementById('historyDetailTitle');
  const transcriptEl = document.getElementById('historyDetailTranscript');
  if (!detail) return;

  currentHistoryDetailId = id;
  const entry = getHistoryEntry(id);
  if (!entry) return;

  if (titleEl) titleEl.textContent = entry.title || 'Recording';

  // Render transcript
  if (transcriptEl) {
    if (entry.lines && entry.lines.length > 0) {
      transcriptEl.innerHTML = entry.lines
        .filter(line => line.speaker !== -2 && line.speaker !== 0)
        .map(line => `<p>${escapeHtml(line.text || '')}</p>`)
        .join('');
    } else {
      transcriptEl.innerHTML = `<p>${escapeHtml(entry.plainText || 'No transcript')}</p>`;
    }
  }

  // Reset player state
  const seekBar = document.getElementById('historySeekBar');
  const timeDisplay = document.getElementById('historyTimeDisplay');
  const playBtn = document.getElementById('historyPlayBtn');
  if (seekBar) seekBar.value = 0;
  if (timeDisplay) timeDisplay.textContent = '0:00 / ' + formatDuration(entry.duration || 0);
  if (playBtn) {
    playBtn.querySelector('.player-icon-play').style.display = '';
    playBtn.querySelector('.player-icon-pause').style.display = 'none';
  }

  stopHistoryPlayback();
  detail.classList.add('visible');
}

function closeHistoryDetail() {
  const detail = document.getElementById('historyDetail');
  if (detail) detail.classList.remove('visible');
  stopHistoryPlayback();
  currentHistoryDetailId = null;
}

async function deleteHistoryEntry(id) {
  if (!confirm('Delete this recording?')) return;

  await historyStore.delete(id);

  // If we're in detail view for this entry, go back
  if (currentHistoryDetailId === id) {
    closeHistoryDetail();
  }

  renderHistoryList();
}

async function clearAllHistory() {
  const entries = historyStore.list();
  if (entries.length === 0) return;
  if (!confirm('Delete all ' + entries.length + ' recording(s)?')) return;

  await historyStore.clearAll();
  closeHistoryDetail();
  renderHistoryList();
}

// --- Per-Item Copy ---
function copyHistoryText(text, buttonElement) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    buttonElement.classList.add('copied');
    setTimeout(() => buttonElement.classList.remove('copied'), 1500);
  }).catch(err => {
    console.error('Failed to copy:', err);
  });
}

// --- Audio Playback ---
async function toggleHistoryPlayback() {
  if (historyAudio && !historyAudio.paused) {
    historyAudio.pause();
    updatePlayPauseIcon(false);
    cancelAnimationFrame(historyAnimFrame);
    return;
  }

  if (historyAudio && historyAudio.src) {
    historyAudio.play();
    updatePlayPauseIcon(true);
    updateSeekBar();
    return;
  }

  // Load audio from IndexedDB
  if (!currentHistoryDetailId) return;
  const blob = await historyStore.getAudio(currentHistoryDetailId);
  if (!blob) {
    console.warn('No audio blob found for', currentHistoryDetailId);
    return;
  }

  const url = URL.createObjectURL(blob);
  historyAudio = new Audio(url);
  historyAudio._objectUrl = url;

  historyAudio.addEventListener('ended', () => {
    updatePlayPauseIcon(false);
    cancelAnimationFrame(historyAnimFrame);
    const seekBar = document.getElementById('historySeekBar');
    if (seekBar) seekBar.value = 100;
  });

  historyAudio.addEventListener('loadedmetadata', () => {
    const timeDisplay = document.getElementById('historyTimeDisplay');
    if (timeDisplay) {
      timeDisplay.textContent = '0:00 / ' + formatDuration(Math.floor(historyAudio.duration));
    }
  });

  try {
    await historyAudio.play();
    updatePlayPauseIcon(true);
    updateSeekBar();
  } catch (err) {
    console.error('Playback failed:', err);
  }
}

function seekHistoryAudio(position) {
  if (!historyAudio || !historyAudio.duration) return;
  historyAudio.currentTime = (position / 100) * historyAudio.duration;
}

function stopHistoryPlayback() {
  if (historyAudio) {
    historyAudio.pause();
    if (historyAudio._objectUrl) {
      URL.revokeObjectURL(historyAudio._objectUrl);
    }
    historyAudio = null;
  }
  if (historyAnimFrame) {
    cancelAnimationFrame(historyAnimFrame);
    historyAnimFrame = null;
  }
  updatePlayPauseIcon(false);
}

function updatePlayPauseIcon(isPlaying) {
  const playBtn = document.getElementById('historyPlayBtn');
  if (!playBtn) return;
  const playIcon = playBtn.querySelector('.player-icon-play');
  const pauseIcon = playBtn.querySelector('.player-icon-pause');
  if (playIcon) playIcon.style.display = isPlaying ? 'none' : '';
  if (pauseIcon) pauseIcon.style.display = isPlaying ? '' : 'none';
}

function updateSeekBar() {
  if (!historyAudio || historyAudio.paused) return;

  const seekBar = document.getElementById('historySeekBar');
  const timeDisplay = document.getElementById('historyTimeDisplay');

  if (seekBar && historyAudio.duration) {
    seekBar.value = (historyAudio.currentTime / historyAudio.duration) * 100;
  }
  if (timeDisplay && historyAudio.duration) {
    timeDisplay.textContent =
      formatDuration(Math.floor(historyAudio.currentTime)) +
      ' / ' +
      formatDuration(Math.floor(historyAudio.duration));
  }

  historyAnimFrame = requestAnimationFrame(updateSeekBar);
}

// --- Utility ---
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + ':' + s.toString().padStart(2, '0');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
