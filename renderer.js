require('dotenv').config();

const elements = {
  language: document.getElementById('language'), output: document.getElementById('output-device'),
  deepgramKey: document.getElementById('deepgram-key'),
  start: document.getElementById('start'), stop: document.getElementById('stop'), clear: document.getElementById('clear'),
  recordVoice: document.getElementById('record-voice'), voiceState: document.getElementById('voice-state'),
  settings: document.getElementById('settings'), source: document.getElementById('source-text'),
  translated: document.getElementById('translated-text'), status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
};

let audioContext, microphoneStream, transcriptionSocket, ttsSocket, currentAudioElement;
let liveAudioSource, liveAudioProcessor, silentGain;
let audioChunks = [], isPlaying = false, isStopping = false;
let microphoneHasSignal = false, deepgramHasResults = false;
let translationChain = Promise.resolve();
let speechChain = Promise.resolve();
let localPlaybackChain = Promise.resolve();
let voiceServiceReady = false, voiceReferenceReady = false, isRecordingReference = false;
const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_MODEL = 'translategemma:4b';
const VOICE_SERVICE_URL = 'http://localhost:8008';

const savedConfig = JSON.parse(localStorage.getItem('translator-config') || '{}');
delete savedConfig.openaiKey;
localStorage.setItem('translator-config', JSON.stringify(savedConfig));
elements.deepgramKey.value = savedConfig.deepgramKey || process.env.DEEPGRAM_KEY || process.env.DEEPGRAM_API_KEY || '';
elements.language.value = savedConfig.language || 'pt-BR';

function setStatus(message, type = 'idle') { elements.status.dataset.type = type; elements.statusText.textContent = message; }
function setRunning(running) {
  elements.start.disabled = running; elements.stop.disabled = !running;
  elements.language.disabled = running;
  elements.recordVoice.disabled = running || isRecordingReference;
}
function saveConfig() {
  Object.assign(savedConfig, {
    deepgramKey: elements.deepgramKey.value.trim(), language: elements.language.value,
    outputDevice: elements.output.value,
  });
  localStorage.setItem('translator-config', JSON.stringify(savedConfig));
}
function isVirtualOutputSelected() {
  return /cable|blackhole/i.test(elements.output.selectedOptions[0]?.textContent || '');
}
function appendText(element, text) {
  element.querySelector('.interim')?.remove();
  element.append(document.createTextNode(`${element.textContent.trim() ? ' ' : ''}${text}`));
  element.scrollTop = element.scrollHeight;
}
function showInterimText(text) {
  let interim = elements.source.querySelector('.interim');
  if (!interim) {
    interim = document.createElement('span');
    interim.className = 'interim';
    elements.source.append(document.createTextNode(elements.source.textContent.trim() ? ' ' : ''));
    elements.source.append(interim);
  }
  interim.textContent = text;
  elements.source.scrollTop = elements.source.scrollHeight;
}

async function populateOutputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const previousValue = savedConfig.outputDevice || elements.output.value;
  elements.output.innerHTML = '<option value="default">Alto-falante padrão</option>';
  for (const device of devices.filter(({ kind }) => kind === 'audiooutput')) {
    const label = device.label || `Saída de áudio ${elements.output.options.length}`;
    const option = new Option(label, device.deviceId);
    if (/cable|blackhole/i.test(label)) option.textContent = `${label} (cabo virtual)`;
    elements.output.add(option);
  }
  const options = [...elements.output.options];
  if (savedConfig.outputDevice && options.some(({ value }) => value === previousValue)) {
    elements.output.value = previousValue;
  } else if (!savedConfig.outputDevice) {
    const virtualCable = options.find(({ textContent }) => /cable|blackhole/i.test(textContent));
    if (virtualCable) elements.output.value = virtualCable.value;
  }
  saveConfig();
}

async function prepareAudio() {
  audioContext ||= new AudioContext({ latencyHint: 'interactive' });
  if (audioContext.state === 'suspended') await audioContext.resume();
  microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  await populateOutputDevices();
}

function startPcmStreaming() {
  microphoneHasSignal = false;
  deepgramHasResults = false;
  liveAudioSource = audioContext.createMediaStreamSource(microphoneStream);
  liveAudioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  liveAudioProcessor.onaudioprocess = ({ inputBuffer }) => {
    if (transcriptionSocket?.readyState !== WebSocket.OPEN) return;
    const input = inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    let peak = 0;
    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, input[index]));
      peak = Math.max(peak, Math.abs(sample));
      pcm[index] = sample < 0 ? sample * 32768 : sample * 32767;
    }
    transcriptionSocket.send(pcm.buffer);
    if (!microphoneHasSignal && peak > 0.015) {
      microphoneHasSignal = true;
      setStatus('Microfone detectado. Ouvindo sua fala...', 'ok');
    }
  };
  liveAudioSource.connect(liveAudioProcessor);
  liveAudioProcessor.connect(silentGain);
  silentGain.connect(audioContext.destination);
}

function stopPcmStreaming() {
  if (liveAudioProcessor) liveAudioProcessor.onaudioprocess = null;
  liveAudioSource?.disconnect();
  liveAudioProcessor?.disconnect();
  silentGain?.disconnect();
  liveAudioSource = null;
  liveAudioProcessor = null;
  silentGain = null;
}

function getRecorderOptions() {
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
  return mimeType ? { mimeType } : undefined;
}

async function startRecording() {
  const deepgramKey = elements.deepgramKey.value.trim();
  if (!deepgramKey) { elements.settings.open = true; setStatus('Informe a chave da Deepgram.', 'error'); return; }
  isStopping = false; setRunning(true); setStatus('Verificando o tradutor local...', 'working');
  try {
    await checkLocalTranslator();
    await refreshVoiceStatus();
    if (voiceReferenceReady && !voiceServiceReady) throw new Error('O modelo da sua voz ainda está carregando. Aguarde o indicador ficar pronto.');
    setStatus('Solicitando acesso ao microfone...', 'working');
    await prepareAudio();
    saveConfig();
    const query = new URLSearchParams({
      model: 'nova-3', language: elements.language.value, encoding: 'linear16',
      sample_rate: String(audioContext.sampleRate), channels: '1', interim_results: 'true',
      endpointing: '300', smart_format: 'true', punctuate: 'true', vad_events: 'true',
    });
    transcriptionSocket = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, ['token', deepgramKey]);
    transcriptionSocket.onopen = () => {
      if (!isStopping) {
        startPcmStreaming();
        setStatus('Microfone conectado. Fale normalmente e faça pequenas pausas.', 'ok');
      }
    };
    transcriptionSocket.onmessage = handleTranscription;
    transcriptionSocket.onerror = () => setStatus('Falha na conexão com a Deepgram. Confira a chave e sua conexão.', 'error');
    transcriptionSocket.onclose = ({ code, reason }) => {
      if (!isStopping && code !== 1000) { setStatus(`A Deepgram encerrou a conexão (${code}${reason ? `: ${reason}` : ''}).`, 'error'); stopRecording(false); }
    };
  } catch (error) { setStatus(`Não foi possível iniciar: ${error.message}`, 'error'); stopRecording(false); }
}

async function handleTranscription(event) {
  try {
    const result = JSON.parse(event.data);
    if (result.type === 'SpeechStarted') {
      setStatus('Fala detectada pela Deepgram...', 'ok');
      return;
    }
    if (result.type !== 'Results') return;
    deepgramHasResults = true;
    const transcript = result.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) return;
    if (!result.is_final) {
      showInterimText(transcript);
      setStatus(`Ouvindo: “${transcript}”`, 'ok');
      return;
    }
    appendText(elements.source, transcript);
    setStatus('Traduzindo localmente...', 'working');
    translationChain = translationChain.then(async () => {
      const translation = await translateLocally(transcript);
      if (!translation) return;
      appendText(elements.translated, translation);
      setStatus('Tradução pronta · gerando voz...', 'working');
      queueSpeech(translation);
    }).catch((error) => setStatus(`Erro ao traduzir: ${error.message}`, 'error'));
  } catch (error) { setStatus(`Erro ao processar a fala: ${error.message}`, 'error'); }
}

async function checkLocalTranslator() {
  let response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/tags`);
  } catch (_) {
    throw new Error('O Ollama não está acessível. Inicie o container video-ollama no Docker Desktop.');
  }
  if (!response.ok) throw new Error(`Ollama indisponível (${response.status}).`);
  const data = await response.json();
  if (!data.models?.some(({ name }) => name === OLLAMA_MODEL)) {
    throw new Error(`O modelo ${OLLAMA_MODEL} não está instalado no Ollama.`);
  }
  const warmup = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL, stream: false, keep_alive: -1,
      messages: [{ role: 'user', content: 'Translate Portuguese to English. Return only the translation.\n\nOlá.' }],
      options: { temperature: 0, num_predict: 16, num_ctx: 1024 },
    }),
  });
  if (!warmup.ok) throw new Error(`Não foi possível aquecer o tradutor local (${warmup.status}).`);
}

function sourceLanguage() {
  return {
    'pt-BR': ['Brazilian Portuguese', 'pt'], 'pt-PT': ['European Portuguese', 'pt'],
    es: ['Spanish', 'es'], fr: ['French', 'fr'], de: ['German', 'de'],
    it: ['Italian', 'it'], 'en-US': ['English', 'en'], multi: ['automatically detected language', 'auto'],
  }[elements.language.value] || ['automatically detected language', 'auto'];
}

function splitForSpeech(text, maxWords = 6) {
  const phrases = text.match(/[^,;:.!?]+[,;:.!?]?/g) || [text];
  const chunks = [];
  for (const phrase of phrases) {
    const words = phrase.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const chunkCount = Math.ceil(words.length / maxWords);
    const chunkSize = Math.ceil(words.length / chunkCount);
    for (let index = 0; index < words.length; index += chunkSize) {
      chunks.push(words.slice(index, index + chunkSize).join(' '));
    }
  }
  return chunks;
}

function queueSpeech(text) {
  for (const chunk of splitForSpeech(text)) {
    speechChain = speechChain
      .then(() => sendToTTS(chunk))
      .catch((error) => setStatus(`Erro ao gerar voz: ${error.message}`, 'error'));
  }
}

async function translateLocally(text) {
  const [languageName, languageCode] = sourceLanguage();
  const prompt = `Translate from ${languageName} (${languageCode}) to natural English. Return only the translation. Preserve names and words already in English.\n\n${text}`;
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL, stream: false, keep_alive: -1,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0, num_predict: 96, num_ctx: 1024 },
    }),
  });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(`Ollama ${response.status}: ${body.error || response.statusText}`); }
  const data = await response.json();
  return data.message?.content?.trim().replace(/^['"]|['"]$/g, '') || '';
}

async function refreshVoiceStatus() {
  try {
    const response = await fetch(`${VOICE_SERVICE_URL}/health`);
    if (!response.ok) throw new Error('offline');
    const data = await response.json();
    voiceServiceReady = Boolean(data.model_ready);
    voiceReferenceReady = Boolean(data.voice_ready);
    if (data.status === 'error') {
      elements.voiceState.textContent = `Erro no modelo: ${data.error || 'desconhecido'}`;
    } else if (!data.model_ready) {
      elements.voiceState.textContent = voiceReferenceReady ? 'Amostra salva · carregando modelo de voz...' : 'Carregando modelo de voz local...';
    } else if (data.voice_ready) {
      elements.voiceState.textContent = 'Sua voz está pronta para uso.';
      elements.recordVoice.textContent = 'Gravar nova amostra';
    } else {
      elements.voiceState.textContent = 'Modelo pronto · grave sua amostra.';
    }
    return data;
  } catch (_) {
    voiceServiceReady = false;
    elements.voiceState.textContent = 'Serviço de voz local indisponível.';
    return null;
  }
}

async function recordVoiceReference() {
  if (isRecordingReference) return;
  const health = await refreshVoiceStatus();
  if (!health) {
    setStatus('O serviço local de clonagem de voz não está disponível.', 'error');
    return;
  }
  isRecordingReference = true;
  elements.recordVoice.disabled = true;
  elements.start.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const recorder = new MediaRecorder(stream, getRecorderOptions());
    const chunks = [];
    recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = ({ error }) => reject(error || new Error('Falha na gravação'));
    });
    recorder.start(250);
    let remaining = 12;
    elements.recordVoice.textContent = `Gravando... ${remaining}s`;
    const countdown = setInterval(() => {
      remaining -= 1;
      elements.recordVoice.textContent = `Gravando... ${Math.max(remaining, 0)}s`;
    }, 1000);
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    clearInterval(countdown);
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    const form = new FormData();
    form.append('audio', blob, 'my-voice.webm');
    elements.voiceState.textContent = 'Processando sua amostra...';
    const response = await fetch(`${VOICE_SERVICE_URL}/voice-reference`, { method: 'POST', body: form });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `erro ${response.status}`);
    }
    voiceReferenceReady = true;
    elements.recordVoice.textContent = 'Gravar nova amostra';
    elements.voiceState.textContent = voiceServiceReady ? 'Sua voz está pronta para uso.' : 'Amostra salva · carregando modelo de voz...';
    setStatus('Amostra de voz salva localmente.', 'ok');
  } catch (error) {
    elements.recordVoice.textContent = voiceReferenceReady ? 'Gravar nova amostra' : 'Gravar amostra de voz';
    setStatus(`Não foi possível gravar sua voz: ${error.message}`, 'error');
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    isRecordingReference = false;
    elements.recordVoice.disabled = false;
    elements.start.disabled = false;
  }
}

function connectTTS() {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ model: 'aura-2-thalia-en', encoding: 'linear16', sample_rate: '48000' });
    ttsSocket = new WebSocket(`wss://api.deepgram.com/v1/speak?${params}`, ['token', elements.deepgramKey.value.trim()]);
    ttsSocket.binaryType = 'arraybuffer'; ttsSocket.onopen = resolve;
    ttsSocket.onerror = () => reject(new Error('Falha ao conectar à voz da Deepgram'));
    ttsSocket.onmessage = handleTTSMessage; ttsSocket.onclose = () => { ttsSocket = null; };
  });
}
async function sendToTTS(text) {
  if (voiceReferenceReady && voiceServiceReady) {
    await sendToLocalVoice(text);
    return;
  }
  if (!ttsSocket || ttsSocket.readyState >= WebSocket.CLOSING) await connectTTS();
  if (ttsSocket.readyState !== WebSocket.OPEN) throw new Error('A conexão de voz não está pronta');
  ttsSocket.send(JSON.stringify({ type: 'Speak', text })); ttsSocket.send(JSON.stringify({ type: 'Flush' }));
}

async function sendToLocalVoice(text) {
  const response = await fetch(`${VOICE_SERVICE_URL}/synthesize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Voz local ${response.status}: ${body.detail || response.statusText}`);
  }
  const audioBlob = await response.blob();
  localPlaybackChain = localPlaybackChain.then(() => playLocalAudio(audioBlob)).catch((error) => {
    setStatus(`Erro ao reproduzir sua voz: ${error.message}`, 'error');
  });
}

async function playLocalAudio(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const routedAudio = new Audio(url);
    if (elements.output.value !== 'default' && typeof routedAudio.setSinkId === 'function') {
      await routedAudio.setSinkId(elements.output.value);
    }
    const players = [routedAudio];
    if (elements.output.value !== 'default' && isVirtualOutputSelected()) players.push(new Audio(url));
    await Promise.all(players.map(async (audio) => {
      const ended = new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = () => reject(new Error('falha no áudio sintetizado'));
      });
      await audio.play();
      await ended;
    }));
    setStatus('Ouvindo. Continue falando.', 'ok');
  } finally {
    URL.revokeObjectURL(url);
  }
}
function handleTTSMessage(event) {
  if (event.data instanceof ArrayBuffer) { audioChunks.push(event.data); return; }
  try { if (JSON.parse(event.data).type === 'Flushed') playQueuedAudio(); } catch (_) { /* ignora controle desconhecido */ }
}

async function playQueuedAudio() {
  if (isPlaying || !audioChunks.length) return;
  isPlaying = true;
  try {
    const chunks = audioChunks.splice(0), totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const pcm = new Uint8Array(totalLength); let offset = 0;
    for (const chunk of chunks) { pcm.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
    const view = new DataView(pcm.buffer), samples = new Float32Array(Math.floor(view.byteLength / 2));
    for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
    const buffer = audioContext.createBuffer(1, samples.length, 48000); buffer.copyToChannel(samples, 0);
    const source = audioContext.createBufferSource(); source.buffer = buffer;
    const selectedDevice = elements.output.value;
    if (selectedDevice !== 'default' && typeof HTMLMediaElement.prototype.setSinkId === 'function') {
      const destination = audioContext.createMediaStreamDestination(); source.connect(destination);
      if (isVirtualOutputSelected()) source.connect(audioContext.destination);
      currentAudioElement = new Audio(); currentAudioElement.srcObject = destination.stream;
      await currentAudioElement.setSinkId(selectedDevice); await currentAudioElement.play();
    } else source.connect(audioContext.destination);
    source.onended = () => { isPlaying = false; currentAudioElement = null; setStatus('Ouvindo. Continue falando.', 'ok'); if (audioChunks.length) playQueuedAudio(); };
    source.start();
  } catch (error) { isPlaying = false; setStatus(`Erro ao reproduzir áudio: ${error.message}`, 'error'); }
}

function stopRecording(showStatus = true) {
  isStopping = true;
  stopPcmStreaming();
  microphoneStream?.getTracks().forEach((track) => track.stop());
  if (transcriptionSocket?.readyState === WebSocket.OPEN) transcriptionSocket.close(1000, 'User stopped');
  if (ttsSocket?.readyState === WebSocket.OPEN) { ttsSocket.send(JSON.stringify({ type: 'Close' })); ttsSocket.close(1000, 'User stopped'); }
  microphoneStream = null; transcriptionSocket = null; ttsSocket = null; setRunning(false);
  if (showStatus) setStatus('Tradução interrompida.', 'idle');
}

elements.start.addEventListener('click', startRecording);
elements.stop.addEventListener('click', () => stopRecording());
elements.recordVoice.addEventListener('click', recordVoiceReference);
elements.output.addEventListener('change', saveConfig);
elements.clear.addEventListener('click', () => {
  elements.source.innerHTML = '<span class="interim">O texto falado aparecerá aqui.</span>';
  elements.translated.innerHTML = '<span class="interim">A tradução aparecerá aqui.</span>';
});
window.addEventListener('beforeunload', () => stopRecording(false));
if (elements.deepgramKey.value) {
  checkLocalTranslator()
    .then(() => setStatus('Deepgram e tradutor local prontos para iniciar.', 'ok'))
    .catch((error) => setStatus(error.message, 'error'));
} else elements.settings.open = true;
refreshVoiceStatus();
populateOutputDevices().catch(() => { /* a lista será atualizada apó liberar o microfone */ });
setInterval(refreshVoiceStatus, 5000);
