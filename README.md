## chrome-capture-for-kayo

Capture video and audio from a Chrome tab using the [`chrome.tabCapture`](https://developer.chrome.com/docs/extensions/reference/tabCapture/) API. Built on [Puppeteer](https://pptr.dev/) and [puppeteer-stream](https://github.com/SamuelScheit/puppeteer-stream)

### setup

download the latest [release](https://github.com/tresby/chrome-capture-for-kayo/releases) for macOS or Windows


### usage

Requiremnts (run command in terminal): npm install puppeteer-core puppeteer-stream express morgan yargs console-stamp

a http server is listening on port 5589 and responds to these routes. the response is a webm stream with h264 video and opus audio, that is then remuxed into a mpegts container and the audio is transcoded to aac.

- On first launch, please use the chrome tab to log into kayo
- `http://<ip>:5589/playlist.m3u` full m3u kayo playlist (12 channels)
- HDHR emulation (plex) - can be added with `http://<ip>:5589`


### development

to setup a development environment where you can edit and run `main.js`:

#### windows

```
winget install -e --id Git.Git
winget install -e --id Oven-sh.Bun

git clone https://github.com/tresby/chrome-capture-for-kayo
cd chrome-capture-for-channels
npm install puppeteer-core puppeteer-stream express morgan yargs console-stamp
bun install
bun main.js
```

#### mac

```
brew install git
brew install oven-sh/bun/bun

git clone https://github.com/tresby/chrome-capture-for-kayo
cd chrome-capture-for-channels
npm install puppeteer-core puppeteer-stream express morgan yargs console-stamp
bun install
bun main.js
```

#### upcoming

- Config webui (bitrate, resolution, start delay, kayo log in, Tuner count)
- Potential Binge support
- Potential Aus FTA channel support

#### notes

This could break at any point if kayo change their website. 
This is only intended as a way to get an EPG style layout for kayo live channels, 
will likely stop updating if a EPG was bought to the Kayo Apple TV app. 
Please only use this for personal consumption - not distributing streams (not the intended purpose)
