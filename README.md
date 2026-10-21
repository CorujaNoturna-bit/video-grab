# Video Grabber

Extensão que detecta os vídeos carregados pela página e os baixa.

## Recursos

- Download de arquivos direto
- Junta áudio e vídeo separados em um único `.mp4` (ffmpeg.wasm, sem recodificar)
- Escolha da pasta de destino (File System Access API)
- Se a junção falhar, salva os arquivos separados

## Limitações

- Não suporta conteúdo com DRM, streams criptografados ou ao vivo
- Uso pessoal: respeite os termos de uso dos sites e os direitos autorais

## Necessário

```bash
npm install
npm run build
```

Depois, em `chrome://extensions`, ative o modo do desenvolvedor, clique em "Carregar sem compactação" e selecione a pasta `dist`.
