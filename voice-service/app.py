import asyncio
import io
import subprocess
import threading
from pathlib import Path

import soundfile as sf
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from chatterbox.tts_turbo import ChatterboxTurboTTS


DATA_DIR = Path("/data")
REFERENCE_PATH = DATA_DIR / "my-voice.wav"
MODEL_LOCK = threading.Lock()
model = None
model_error = None

app = FastAPI(title="Local Voice Clone Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null", "file://"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)


def load_model():
    global model, model_error
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        loaded_model = ChatterboxTurboTTS.from_pretrained(device=torch.device("cuda"))
        if REFERENCE_PATH.exists():
            loaded_model.prepare_conditionals(str(REFERENCE_PATH), exaggeration=0.0)
            loaded_model.generate("Ready.", exaggeration=0.0, cfg_weight=0.0, temperature=0.7)
        model = loaded_model
    except Exception as error:  # surfaced by /health for the desktop app
        model_error = str(error)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(asyncio.to_thread(load_model))


@app.get("/health")
def health():
    return {
        "status": "error" if model_error else ("ready" if model is not None else "loading"),
        "model_ready": model is not None,
        "voice_ready": REFERENCE_PATH.exists(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "error": model_error,
    }


@app.post("/voice-reference")
async def save_voice_reference(audio: UploadFile = File(...)):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    uploaded_path = DATA_DIR / "voice-upload"
    content = await audio.read()
    if len(content) < 10_000:
        raise HTTPException(status_code=400, detail="A gravação está vazia ou curta demais.")
    uploaded_path.write_bytes(content)
    command = [
        "ffmpeg", "-y", "-i", str(uploaded_path), "-ac", "1", "-ar", "24000",
        "-af", "highpass=f=70,lowpass=f=10000,loudnorm", str(REFERENCE_PATH),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    uploaded_path.unlink(missing_ok=True)
    if result.returncode != 0 or not REFERENCE_PATH.exists():
        raise HTTPException(status_code=400, detail="Não foi possível processar a gravação de voz.")
    if model is not None:
        await asyncio.to_thread(prepare_voice_reference)
    return {"ok": True, "voice_ready": True}


def prepare_voice_reference():
    with MODEL_LOCK:
        model.prepare_conditionals(str(REFERENCE_PATH), exaggeration=0.0)


def generate_audio(text: str) -> bytes:
    with MODEL_LOCK:
        wav = model.generate(
            text,
            exaggeration=0.0,
            cfg_weight=0.0,
            temperature=0.7,
        )
    audio = wav.squeeze().detach().cpu().numpy()
    buffer = io.BytesIO()
    sf.write(buffer, audio, model.sr, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


@app.post("/synthesize")
async def synthesize(request: SynthesisRequest):
    if model_error:
        raise HTTPException(status_code=500, detail=model_error)
    if model is None:
        raise HTTPException(status_code=503, detail="O modelo de voz ainda está carregando.")
    if not REFERENCE_PATH.exists():
        raise HTTPException(status_code=409, detail="Grave uma amostra da sua voz primeiro.")
    try:
        wav = await asyncio.to_thread(generate_audio, request.text.strip())
        return Response(content=wav, media_type="audio/wav")
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Falha na síntese: {error}") from error
