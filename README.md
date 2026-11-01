# Video Grabber

O **Video Grabber** é uma extensão para navegador que permite identificar e baixar vídeos e áudios diretamente de páginas da internet.

A ideia do projeto é facilitar o download de conteúdos disponíveis na web, reunindo diferentes formatos e tecnologias em uma única ferramenta.

## Recursos

- **Download de vídeos:** Identifica e permite baixar arquivos em formatos como MP4 e WebM.
- **Suporte a HLS:** Permite baixar vídeos transmitidos em partes (`.m3u8`), reunindo os segmentos em um único arquivo.
- **Áudio e vídeo juntos:** Combina automaticamente faixas de áudio e vídeo em um único MP4 usando FFmpeg.
- **Compatibilidade com plataformas:** Possui suporte com diversas plataformas.
- **Informações do vídeo:** Exibe dados como duração, resolução, formato e tamanho estimado antes do download.
- **Downloads alternativos:** Caso não seja possível combinar o áudio e o vídeo, a extensão salva os arquivos separadamente.
- **Escolha de destino:** Permite selecionar uma pasta para salvar os downloads ou utilizar a pasta padrão do navegador.

## Limitações

- Não oferece suporte a conteúdos protegidos por DRM.
- Não suporta transmissões ao vivo que não tenham uma lista de reprodução finalizada.

**Aviso:** O projeto tem finalidade pessoal e educacional. Ao utilizar a extensão, respeite os direitos autorais e os termos de uso das plataformas.

## Instalação e desenvolvimento

### Pré-requisitos

É necessário ter o Node.js e o npm instalados.

### Instalação

Clone o repositório e instale as dependências:

```bash
npm install
```

### Compilação

Execute o comando abaixo para gerar a versão compilada da extensão:

```bash
npm run build
```
