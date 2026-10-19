# Tradutor de voz em tempo real

Aplicativo Electron que captura o microfone, transcreve a fala com a Deepgram, traduz localmente para inglês com o Ollama e reproduz a tradução com uma cópia local da sua voz. Sem amostra de voz, usa a voz padrão da Deepgram como alternativa.

## Requisitos

- Node.js 20 ou mais recente
- Uma chave de API da [Deepgram](https://console.deepgram.com/)
- Ollama disponível em `http://localhost:11434` com o modelo `translategemma:4b`
- Docker com GPU para a clonagem local de voz com Chatterbox Turbo
- Opcional: [VB-Cable](https://vb-audio.com/Cable/) no Windows para encaminhar a voz traduzida como microfone em reuniões

## Executar no Windows

```powershell
npm.cmd install
npm.cmd start
```

O uso de `npm.cmd` evita o bloqueio do script `npm.ps1` quando a política de execução do PowerShell é restrita.

Neste computador, inicie o container existente do Ollama antes do aplicativo:

```powershell
docker start video-ollama
```

O modelo local já foi instalado no volume persistente do Docker. Em outra instalação do Ollama, use `ollama pull translategemma:4b`.

Inicie também o serviço local de clonagem de voz:

```powershell
docker compose -f docker-compose.voice.yml up -d
```

Na primeira execução, abra **Configuração**, cole somente a chave da Deepgram e clique em **Iniciar tradução**. A chave fica no armazenamento local do Electron. Como alternativa, copie `.env.example` para `.env` e preencha `DEEPGRAM_KEY`.

Para usar seu próprio timbre, clique em **Gravar amostra de voz**, fale naturalmente durante 12 segundos e espere o indicador informar que a voz está pronta. A gravação fica em `voice-data/my-voice.wav`, ignorada pelo Git.

Quando o VB-Cable está instalado, o aplicativo o seleciona automaticamente, envia a tradução para a chamada e mantém uma cópia no alto-falante local. No Zoom, Teams, Discord ou Meet, selecione `CABLE Output (VB-Audio Virtual Cable)` como microfone.

## Observações

- O idioma de destino atual é inglês porque a voz configurada (`aura-2-thalia-en`) é inglesa.
- O fluxo usa transcrições finais da Deepgram para evitar traduções duplicadas.
- A tradução acontece localmente na GPU e não exige chave nem créditos da OpenAI.
- Quando uma amostra existe, a voz em inglês é sintetizada localmente pelo Chatterbox Turbo; sem amostra, a voz padrão da Deepgram é usada como fallback.
- A Deepgram continua sendo um serviço externo e pode ser limitada por créditos.
