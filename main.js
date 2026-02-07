const { launch: puppeteerLaunch } = require('puppeteer-core');
const { launch, getStream } = require('puppeteer-stream');
const fs = require('fs');
const child_process = require('child_process');
const process = require('process');
const path = require('path');
const express = require('express');
const morgan = require('morgan');

require('console-stamp')(console, {
  format: ':date(yyyy/mm/dd HH:MM:ss.l)',
});

// --- suppress harmless first-run extension error, but still restart ---
const EXT_ID = 'jjndjgheafjngoipoacpjgeicjeomjli';

process.on('unhandledRejection', function (reason) {
  const msg = String((reason && reason.message) ? reason.message : (reason || ''));
  if (
    msg.indexOf('net::ERR_BLOCKED_BY_CLIENT') !== -1 &&
    msg.indexOf('chrome-extension://' + EXT_ID + '/options.html') !== -1
  ) {
    console.log('[Info] Restarting following first-run puppeteer-stream extension installation');
    process.exit(1);
    return;
  }
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
// ---------------------------------------------------------------------

// Parse command line arguments
const argv = require('yargs')
  .option('videoBitrate', {
    alias: 'v',
    description: 'Video bitrate in bits per second',
    type: 'number',
    default: 8000000,
  })
  .option('audioBitrate', {
    alias: 'a',
    description: 'Audio bitrate in bits per second',
    type: 'number',
    default: 256000,
  })
  .option('frameRate', {
    alias: 'f',
    description: 'Minimum frame rate',
    type: 'number',
    default: 50,
  })
  .option('port', {
    alias: 'p',
    description: 'Port number for the server',
    type: 'number',
    default: 5589,
  })
  .option('width', {
    alias: 'w',
    description: 'Video width in pixels (e.g., 1920 for 1080p)',
    type: 'number',
    default: 1920,
  })
  .option('height', {
    alias: 'h',
    description: 'Video height in pixels (e.g., 1080 for 1080p)',
    type: 'number',
    default: 1080,
  })
  .option('minimizeWindow', {
    alias: 'm',
    description: 'Minimize window on start',
    type: 'boolean',
    default: false,
  })
  .option('outputFormat', {
    alias: 'o',
    description: 'Output format: webm or mpegts',
    type: 'string',
    default: 'mpegts',
    choices: ['webm', 'mpegts'],
  })
  .scriptName('cc4c')
  .usage('Usage: $0 [options]')
  .wrap(null)
  .help()
  .alias('help', '?')
  .version(false).argv;

// Display settings
console.log('Selected settings:');
console.log('Video Bitrate: ' + argv.videoBitrate + ' bps (' + (argv.videoBitrate / 1000000) + 'Mbps)');
console.log('Audio Bitrate: ' + argv.audioBitrate + ' bps (' + (argv.audioBitrate / 1000) + 'kbps)');
console.log('Minimum Frame Rate: ' + argv.frameRate + ' fps');
console.log('Port: ' + argv.port);
console.log('Resolution: ' + argv.width + 'x' + argv.height);
console.log('Output Format: ' + argv.outputFormat);

const encodingParams = {
  videoBitsPerSecond: argv.videoBitrate,
  audioBitsPerSecond: argv.audioBitrate,
  minFrameRate: argv.frameRate,
  maxFrameRate: 50,
  mimeType: 'video/webm;codecs=H264',
};

const viewport = {
  width: argv.width,
  height: argv.height,
};

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

let currentBrowser = null;
let dataDir = null;
let cachedFFmpegPath = null;

// ---------------- FFmpeg MPEG-TS Transcoder ----------------
async function findFFmpegPath() {
  if (cachedFFmpegPath) return cachedFFmpegPath;

  // Check if ffmpeg is in PATH
  try {
    if (process.platform === 'win32') {
      child_process.execSync('where ffmpeg', { stdio: 'ignore' });
      cachedFFmpegPath = 'ffmpeg';
    } else {
      child_process.execSync('which ffmpeg', { stdio: 'ignore' });
      cachedFFmpegPath = 'ffmpeg';
    }
    return cachedFFmpegPath;
  } catch (e) {
    // FFmpeg not in PATH
  }

  // Check common installation paths
  const commonPaths = process.platform === 'win32'
    ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
    : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      cachedFFmpegPath = p;
      return cachedFFmpegPath;
    }
  }

  throw new Error('FFmpeg not found. Please install FFmpeg or set it in your PATH.');
}

function spawnMpegTsTranscoder(audioBitrate, onError, streamId) {
  const ffmpegPath = cachedFFmpegPath || 'ffmpeg';
  const aacEncoder = process.platform === 'darwin' ? 'aac_at' : 'aac';

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', 'pipe:0',
    '-ss', '1',
    '-c:v', 'copy',
    '-c:a', aacEncoder,
    '-b:a', String(audioBitrate),
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'mpegts',
    '-mpegts_flags', 'initial_discontinuity',
    '-flush_packets', '1',
    'pipe:1'
  ];

  const ffmpeg = child_process.spawn(ffmpegPath, args, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const logPrefix = streamId ? '[' + streamId + '] ' : '';
  let shuttingDown = false;

  ffmpeg.stderr.on('data', function (data) {
    if (shuttingDown) return;
    const message = data.toString().trim();
    const noisePatterns = ['Press [q] to stop', 'frame=', 'size=', 'time=', 'bitrate=', 'speed='];
    if (noisePatterns.some(p => message.includes(p))) return;
    if (message.length > 0) {
      console.log(logPrefix + 'FFmpeg: ' + message);
    }
  });

  ffmpeg.on('exit', function (code, signal) {
    if (shuttingDown) return;
    if (signal === 'SIGTERM') return;
    if (code !== null && code !== 0) {
      onError(new Error('FFmpeg exited with code ' + code));
    } else if (signal) {
      onError(new Error('FFmpeg killed by signal ' + signal));
    }
  });

  ffmpeg.on('error', function (error) {
    if (shuttingDown) return;
    onError(error);
  });

  const kill = function () {
    shuttingDown = true;
    if (!ffmpeg.killed) {
      ffmpeg.kill('SIGTERM');
    }
  };

  return {
    kill: kill,
    process: ffmpeg,
    stdin: ffmpeg.stdin,
    stdout: ffmpeg.stdout
  };
}
// -----------------------------------------------------------

// ---------------- Tile Click Direct Channel Selection ----------------
async function tileClickDirectStrategy(page, channelSlug) {
  // Helper to scroll and click
  async function scrollAndClick(target) {
    await delay(200);
    await page.mouse.click(target.x, target.y);
    return true;
  }

  // Find the channel tile by matching the slug in image URLs
  const tileTarget = await page.evaluate(function (slug) {
    const images = document.querySelectorAll('img');

    for (const img of Array.from(images)) {
      if (img.src && img.src.includes(slug)) {
        // Walk up DOM to find clickable ancestor
        let ancestor = img.parentElement;
        let pointerFallback = null;

        while (ancestor && ancestor !== document.body) {
          const tag = ancestor.tagName;

          // Check for semantic clickable elements
          if (
            tag === 'A' ||
            tag === 'BUTTON' ||
            ancestor.getAttribute('role') === 'button' ||
            ancestor.hasAttribute('onclick')
          ) {
            ancestor.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
            const rect = ancestor.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
          }

          // Track cursor:pointer fallback
          if (!pointerFallback) {
            const rect = ancestor.getBoundingClientRect();
            if (
              rect.width > 20 &&
              rect.height > 20 &&
              window.getComputedStyle(ancestor).cursor === 'pointer'
            ) {
              pointerFallback = ancestor;
            }
          }

          ancestor = ancestor.parentElement;
        }

        // Use pointer fallback if no semantic element found
        if (pointerFallback) {
          pointerFallback.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
          const rect = pointerFallback.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
        }
      }
    }

    return null;
  }, channelSlug);

  if (!tileTarget) {
    return { success: false, reason: 'Channel tile not found in page images.' };
  }

  // Click the tile to start playback
  await scrollAndClick(tileTarget);
  return { success: true };
}

async function waitForChannelSlugImage(page, channelSlug, timeoutMs) {
  try {
    await page.waitForFunction(
      function (slug) {
        return Array.from(document.querySelectorAll('img')).some(function (img) {
          return img.src && img.src.includes(slug);
        });
      },
      { timeout: timeoutMs || 3000 },
      channelSlug
    );
    return true;
  } catch (e) {
    return false;
  }
}

async function selectChannelDirect(page, channelSlug) {
  const imageAppeared = await waitForChannelSlugImage(page, channelSlug, 30000);
  if (!imageAppeared) {
    console.warn('Channel slug "' + channelSlug + '" image did not appear, proceeding anyway...');
  }
  return await tileClickDirectStrategy(page, channelSlug);
}
// ----------------------------------------------------------------------

// ---------------- Concurrency Control ----------------
const MAX_CONCURRENT_STREAMS = 2;
const QUEUE_WAIT_MS = 5000;

let activeStreams = 0;
const waiters = [];

function notifyStreamSlot() {
  if (waiters.length > 0) {
    const r = waiters.shift();
    try { r(); } catch (e) {}
  }
}

function waitForStreamSlot(timeoutMs) {
  if (activeStreams < MAX_CONCURRENT_STREAMS) return Promise.resolve(true);

  return new Promise(function (resolve) {
    const timer = setTimeout(function () {
      const idx = waiters.indexOf(onSlot);
      if (idx !== -1) waiters.splice(idx, 1);
      resolve(false);
    }, timeoutMs);

    function onSlot() {
      clearTimeout(timer);
      resolve(true);
    }

    waiters.push(onSlot);
  });
}
// ------------------------------------------------------

// ---------------- Executable Path ----------------
function getExecutablePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  let executablePath = null;

  if (process.platform === 'linux') {
    try {
      executablePath = child_process.execSync('which chromium-browser').toString().split('\n').shift();
    } catch (e) {}
    if (!executablePath) {
      try {
        executablePath = child_process.execSync('which chromium').toString().split('\n').shift();
      } catch (e2) {}
      if (!executablePath) throw new Error('Chromium not found (which chromium)');
    }
  } else if (process.platform === 'darwin') {
    executablePath = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ].find(fs.existsSync);
  } else if (process.platform === 'win32') {
    executablePath = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Chromium', 'Application', 'chrome.exe'),
    ].find(fs.existsSync);
  } else {
    throw new Error('Unsupported platform: ' + process.platform);
  }

  return executablePath;
}

// ---------------- Browser (shared profile) ----------------
async function getCurrentBrowser() {
  if (!currentBrowser || !currentBrowser.isConnected()) {
    currentBrowser = await launch(
      {
        launch: function (opts) {
          if (process.env.DOCKER) {
            opts.args = (opts.args || []).concat([
              '--use-gl=angle',
              '--use-angle=gl-egl',
              '--enable-features=VaapiVideoDecoder,VaapiVideoEncoder',
              '--ignore-gpu-blocklist',
              '--enable-zero-copy',
              '--enable-drdc',
              '--no-sandbox',
            ]);
          }
          console.log('Launching Browser, Opts', opts);
          return puppeteerLaunch(opts);
        },
      },
      {
        executablePath: getExecutablePath(),
        pipe: true,
        headless: false,
        defaultViewport: null,
        userDataDir: path.join(dataDir, 'chromedata'),
        args: [
          '--no-first-run',
          '--hide-crash-restore-bubble',
          '--allow-running-insecure-content',
          '--autoplay-policy=no-user-gesture-required',
          '--disable-blink-features=AutomationControlled',
          '--hide-scrollbars',
          '--window-size=' + viewport.width + ',' + viewport.height,
          '--disable-notifications',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-background-media-suspend',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--force-prefers-reduced-motion',
          '--disable-features=CalculateNativeWinOcclusion',
        ],
        ignoreDefaultArgs: [
          '--enable-automation',
          '--disable-extensions',
          '--disable-default-apps',
          '--disable-component-update',
          '--disable-component-extensions-with-background-pages',
          '--enable-blink-features=IdleDetection',
          '--mute-audio',
        ],
      }
    );

    currentBrowser.on('close', function () {
      currentBrowser = null;
      console.log('Browser closed');
    });

    currentBrowser.on('targetcreated', function (target) {
      console.log('New target page created:', target.url());
    });

    currentBrowser.on('targetchanged', function (target) {
      console.log('Target page changed:', target.url());
    });

    currentBrowser.on('targetdestroyed', function (target) {
      console.log('Browser page closed:', target.url());
    });

    currentBrowser.on('disconnected', function () {
      console.log('Browser disconnected');
      currentBrowser = null;
    });
  }

  return currentBrowser;
}

async function main() {
  dataDir = process.cwd();
  if (process.platform === 'darwin') {
    dataDir = path.join(process.env.HOME || process.cwd(), 'Library', 'Application Support', 'ChromeCapture');
  } else if (process.platform === 'win32') {
    dataDir = path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local', 'ChromeCapture');
  }

  try {
    await fs.promises.mkdir(dataDir, { recursive: true });
  } catch (e) {}

  // Initialize FFmpeg
  if (argv.outputFormat === 'mpegts') {
    try {
      await findFFmpegPath();
      console.log('FFmpeg found:', cachedFFmpegPath);
    } catch (e) {
      console.error('FFmpeg not found. MPEG-TS output will not work.');
      console.error('Please install FFmpeg or use --outputFormat=webm');
    }
  }

  // --- Channel Configuration ---
  const CHANNELS = {
    espn: {
      url: 'https://kayosports.com.au/browse',
      slug: '5bce8eb9e4b0a8faf3c14a94',
      name: 'ESPN',
      number: 509
    },
    footy: {
      url: 'https://kayosports.com.au/browse',
      slug: '5bcefacfe4b0a8faf3c14ae2',
      name: 'Fox Footy',
      number: 504
    },
    cricket: {
      url: 'https://kayosports.com.au/browse',
      slug: '5bcef5ede4b0a8faf3c14acf',
      name: 'Fox Cricket',
      number: 501
    },
    '505': {
      url: 'https://kayosports.com.au/browse',
      slug: '5bcefaf5e4b0cb6f1d7f46fc',
      name: 'Fox Sports 505',
      number: 505
    },
    '503': {
      url: 'https://kayosports.com.au/browse',
      slug: '5bcef93ae4b0a8faf3c14ada',
      name: 'Fox Sports 503',
      number: 503
    },
    '506': {
      url: 'https://kayosports.com.au/browse',
      slug: '5bcefc4ae4b0a8faf3c14aed',
      name: 'Fox Sports 506',
      number: 506
    },
    league: {
      url: 'https://kayosports.com.au/browse',
      slug: '5bcef901e4b0cb6f1d7f46f3',
      name: 'Fox League',
      number: 502
    },
    news: {
      url: 'https://kayosports.com.au/browse',
      slug: '5bcefccee4b0a8faf3c14aef',
      name: 'Fox Sports News',
      number: 500
    },
    racing: {
      url: 'https://kayosports.com.au/browse',
      slug: '5ccacc4ae4b020d0a4eb3979',
      name: 'Racing.com',
      number: 529
    },
    ufc: {
      url: 'https://kayosports.com.au/browse',
      slug: '66d524f4e4b06b17c2bfdd58',
      name: 'Main Event UFC',
      number: 523
    },
    espn2: {
      url: 'https://kayosports.com.au/browse',
      slug: '5bcef583e4b0a8faf3c14acb',
      name: 'ESPN2',
      number: 510
    },
    '507': {
      url: 'https://kayosports.com.au/browse',
      slug: '5bcefc6be4b0cb6f1d7f4703',
      name: 'Fox Sports 507',
      number: 507
    },
  };

  // HDHomeRun Configuration
  const HDHR_DEVICE_ID = 'KAYO1234';
  const HDHR_FRIENDLY_NAME = 'Kayo Sports Tuner';
  const HDHR_TUNER_COUNT = 2;
  const HDHR_PORT = 5004;

  const app = express();

  // logger
  const df = require('dateformat');
  morgan.token('mydate', function () {
    return df(new Date(), 'yyyy/mm/dd HH:MM:ss.l');
  });
  app.use(morgan('[:mydate] :method :url from :remote-addr responded :status in :response-time ms'));

  // ---------------- Page Setup Helpers ----------------
  const pagesInUse = new Set();

  function cssNoAnimOneLine() {
    return (
      '*{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}' +
      '*::before{animation-duration:0s!important;transition-duration:0s!important}' +
      '*::after{animation-duration:0s!important;transition-duration:0s!important}'
    );
  }

  async function ensurePageIsActive(page) {
    try { await page.bringToFront(); } catch (e0) {}

    try {
      const cdp = await page.target().createCDPSession();
      try { await cdp.send('Page.setWebLifecycleState', { state: 'active' }); } catch (e1) {}
      try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e2) {}
    } catch (e3) {}
  }

  async function setupPage(browser) {
    const newPage = await browser.newPage();
    await newPage.setBypassCSP(true);
    await delay(200);

    try {
      await newPage.addStyleTag({ content: cssNoAnimOneLine() });
    } catch (e) {}

    newPage.on('console', function (msg) {
      const text = msg.text();
      if (text.indexOf('Mixed Content') === -1) {
        // console.log(text);
      }
    });

    return newPage;
  }

  async function acquirePage() {
    const browser = await getCurrentBrowser();
    const page = await setupPage(browser);
    pagesInUse.add(page);
    return page;
  }

  async function releasePage(page, reason) {
    if (!page) return;
    if (pagesInUse.has(page)) pagesInUse.delete(page);

    try { await page.close(); } catch (e) {}
    if (reason) console.log('[Page] Closed:', reason);
  }
  // ---------------------------------------------------

  async function setWindowBounds(page) {
    const session = await page.target().createCDPSession();
    const win = await session.send('Browser.getWindowForTarget');

    const extraW = 80;
    const extraH = 160;

    await session.send('Browser.setWindowBounds', {
      windowId: win.windowId,
      bounds: {
        windowState: 'normal',
        width: viewport.width + extraW,
        height: viewport.height + extraH,
      },
    });

    if (argv.minimizeWindow) {
      await session.send('Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds: { windowState: 'minimized' },
      });
    }
  }

  async function minimizeWindow(page) {
    try {
      const session = await page.target().createCDPSession();
      const win = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds: { windowState: 'minimized' },
      });
      
      // Keep page active even when minimized
      try {
        await session.send('Page.setWebLifecycleState', { state: 'active' });
        await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        console.log('[Window] Minimized (kept active)');
      } catch (e) {
        console.log('[Window] Minimized (but failed to force active state)');
      }
    } catch (e) {
      console.log('[Window] Failed to minimize:', e.message);
    }
  }

  async function setChromeViewScale(page, scale) {
    const s = Number(scale);
    if (!isFinite(s) || s <= 0) return;
    const cdp = await page.target().createCDPSession();
    try {
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: s });
    } catch (e1) {
      let zl = 0;
      if (s <= 0.26) zl = -3;
      else if (s <= 0.51) zl = -2;
      else if (s <= 0.76) zl = -1;
      await cdp.send('Browser.setZoomLevel', { zoomLevel: zl }).catch(function () {});
    }
  }

  // ---------------- HDHomeRun Emulation Routes ----------------
  // Discovery endpoint (required for Plex to find the tuner)
  app.get('/discover.json', function (req, res) {
    res.json({
      FriendlyName: HDHR_FRIENDLY_NAME,
      Manufacturer: 'Silicondust',
      ModelNumber: 'HDHR4-2US',
      FirmwareName: 'hdhomerun4_atsc',
      TunerCount: HDHR_TUNER_COUNT,
      FirmwareVersion: '20190621',
      DeviceID: HDHR_DEVICE_ID,
      DeviceAuth: 'test1234',
      BaseURL: req.protocol + '://' + req.get('host'),
      LineupURL: req.protocol + '://' + req.get('host') + '/lineup.json'
    });
  });

  // Device info XML (alternate discovery format)
  app.get('/device.xml', function (req, res) {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
      '<root xmlns="urn:schemas-upnp-org:device-1-0">' +
      '<specVersion><major>1</major><minor>0</minor></specVersion>' +
      '<device>' +
      '<deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>' +
      '<friendlyName>' + HDHR_FRIENDLY_NAME + '</friendlyName>' +
      '<manufacturer>Silicondust</manufacturer>' +
      '<modelName>HDHR4-2US</modelName>' +
      '<modelNumber>HDHR4-2US</modelNumber>' +
      '<serialNumber></serialNumber>' +
      '<UDN>uuid:' + HDHR_DEVICE_ID + '</UDN>' +
      '</device>' +
      '</root>';
    
    res.setHeader('Content-Type', 'application/xml');
    res.send(xml);
  });

  // Lineup endpoint (channel list)
  app.get('/lineup.json', function (req, res) {
    const host = req.get('host');
    const protocol = req.protocol;
    
    const lineup = Object.keys(CHANNELS).map(function (channelKey) {
      const ch = CHANNELS[channelKey];
      return {
        GuideNumber: String(ch.number),
        GuideName: ch.name,
        URL: protocol + '://' + host + '/stream/' + channelKey
      };
    });

    res.json(lineup);
  });

  // Lineup status
  app.get('/lineup_status.json', function (req, res) {
    res.json({
      ScanInProgress: 0,
      ScanPossible: 1,
      Source: 'Cable',
      SourceList: ['Cable']
    });
  });

  // Tuner status (shows active streams)
  app.get('/status.json', function (req, res) {
    res.json({
      ActiveStreams: activeStreams,
      MaxStreams: MAX_CONCURRENT_STREAMS
    });
  });

  // Lineup POST (for tuning)
  app.post('/lineup.post', function (req, res) {
    res.send('OK');
  });
  // -----------------------------------------------------------

  // ---------------- Routes ----------------
  app.get('/', function (req, res) {
    const host = req.get('host');
    const protocol = req.protocol;
    const html =
      '<html>' +
      '<title>Chrome Capture for Channels</title>' +
      '<h2>Chrome Capture for Channels</h2>' +
      '<p>Output Format: <strong>' + argv.outputFormat.toUpperCase() + '</strong></p>' +
      '<h3>HDHomeRun Emulation</h3>' +
      '<p>Device Name: <strong>' + HDHR_FRIENDLY_NAME + '</strong></p>' +
      '<p>Device ID: <strong>' + HDHR_DEVICE_ID + '</strong></p>' +
      '<p>Tuners: <strong>' + HDHR_TUNER_COUNT + '</strong></p>' +
      '<p>To add in Plex:</p>' +
      '<ol>' +
      '<li>Go to Settings &rarr; Live TV &amp; DVR</li>' +
      '<li>Click "Set Up Plex DVR"</li>' +
      '<li>Enter this address: <code>' + protocol + '://' + host.split(':')[0] + ':' + argv.port + '</code></li>' +
      '</ol>' +
      '<h3>Available Channels</h3>' +
      '<table border="1" cellpadding="5" cellspacing="0">' +
      '<tr><th>Number</th><th>Name</th><th>Stream URL</th></tr>' +
      Object.keys(CHANNELS).sort(function (a, b) {
        return CHANNELS[a].number - CHANNELS[b].number;
      }).map(function (k) {
        const ch = CHANNELS[k];
        return '<tr>' +
          '<td align="center">' + ch.number + '</td>' +
          '<td>' + ch.name + '</td>' +
          '<td><a href="' + protocol + '://' + host + '/stream/' + k + '">/stream/' + k + '</a></td>' +
          '</tr>';
      }).join('') +
      '</table>' +
      '<h3>M3U Playlist</h3>' +
      '<p><a href="' + protocol + '://' + host + '/playlist.m3u">Download M3U</a></p>' +
      '<pre>' +
      '#EXTM3U\n\n' +
      Object.keys(CHANNELS).sort(function (a, b) {
        return CHANNELS[a].number - CHANNELS[b].number;
      }).map(function (k) {
        const ch = CHANNELS[k];
        return '#EXTINF:-1 channel-id="kayo-' + k + '" tvg-chno="' + ch.number + '",' + ch.name + '\n' +
               protocol + '://' + host + '/stream/' + k;
      }).join('\n\n') +
      '</pre>' +
      '<h3>HDHomeRun Discovery URLs</h3>' +
      '<ul>' +
      '<li><a href="/discover.json">/discover.json</a> - Device discovery</li>' +
      '<li><a href="/lineup.json">/lineup.json</a> - Channel lineup</li>' +
      '<li><a href="/lineup_status.json">/lineup_status.json</a> - Lineup status</li>' +
      '<li><a href="/device.xml">/device.xml</a> - Device XML</li>' +
      '</ul>' +
      '</html>';

    res.send(html);
  });

  app.get('/playlist.m3u', function (req, res) {
    const host = req.get('host');
    const protocol = req.protocol;
    const m3u = '#EXTM3U\n\n' +
      Object.keys(CHANNELS).sort(function (a, b) {
        return CHANNELS[a].number - CHANNELS[b].number;
      }).map(function (k) {
        const ch = CHANNELS[k];
        return '#EXTINF:-1 channel-id="kayo-' + k + '" tvg-chno="' + ch.number + '" tvg-name="' + ch.name + '",' + ch.name + '\n' +
               protocol + '://' + host + '/stream/' + k;
      }).join('\n\n');

    res.setHeader('Content-Type', 'application/x-mpegurl');
    res.send(m3u);
  });

  // Individual channel streaming endpoint
  app.get('/stream/:channelName', async function (req, res) {
    const channelName = req.params.channelName.toLowerCase();
    const channel = CHANNELS[channelName];

    if (!channel) {
      res.status(404).send('Channel not found. Available channels: ' + Object.keys(CHANNELS).join(', '));
      return;
    }

    await handleChannelStream(req, res, channel, channelName);
  });

  // Legacy /stream?url support
  app.get('/stream', async function (req, res) {
    const u = req.query.url;
    if (!u) {
      res.status(400).send('Missing url parameter');
      return;
    }
    // Legacy mode - no channel selection
    await handleGenericStream(req, res, u);
  });
  // -----------------------------------------------

  async function runKayoFullscreenToggle(page) {
    console.log('[Automation] Requesting fullscreen via browser API...');

    const success = await page.evaluate(function () {
      try {
        // Request fullscreen on the video element if available, otherwise on document
        const video = document.querySelector('video');
        const target = video || document.documentElement;
        
        if (target.requestFullscreen) {
          target.requestFullscreen();
          return true;
        } else if (target.webkitRequestFullscreen) {
          // Safari fallback
          target.webkitRequestFullscreen();
          return true;
        }
        return false;
      } catch (e) {
        console.error('Fullscreen request error:', e);
        return false;
      }
    });

    if (success) {
      console.log('✅ Fullscreen requested via browser API');
    } else {
      console.log('❌ Fullscreen API not available');
    }
    
    return success;
  }

  async function verifyFullscreen(page) {
    // Give it a moment to transition
    await delay(300);
    
    const isFullscreen = await page.evaluate(function () {
      return !!(document.fullscreenElement || 
                document.webkitFullscreenElement || 
                document.mozFullScreenElement ||
                document.msFullscreenElement);
    });

    if (isFullscreen) {
      console.log('[Automation] Fullscreen verified ✓');
    } else {
      console.log('[Automation] Fullscreen verification failed');
    }
    
    return isFullscreen;
  }

  async function handleChannelStream(req, res, channel, channelName) {
    let page = null;
    let stream = null;
    let ffmpegProcess = null;

    const cleanup = async function (reason) {
      if (cleanup._done) return;
      cleanup._done = true;
      console.log('[cleanup]', reason);

      try { if (ffmpegProcess) ffmpegProcess.kill(); } catch (e) {}
      try { if (stream) stream.destroy(); } catch (e) {}

      if (cleanup._countedStream) {
        cleanup._countedStream = false;
        if (activeStreams > 0) activeStreams--;
        console.log('[Streams] Active:', activeStreams);
        notifyStreamSlot();
      }

      await releasePage(page, reason);
    };
    cleanup._done = false;
    cleanup._countedStream = false;

    req.on('aborted', function () { cleanup('req aborted'); });
    res.on('close', function () { cleanup('res close'); });
    res.on('error', function (err) { cleanup('res error ' + err); });

    try {
      await getCurrentBrowser();
      page = await acquirePage();
    } catch (e) {
      console.log('failed to start browser/page', e);
      res.status(500).send('failed to start browser/page: ' + e);
      await cleanup('init failed');
      return;
    }

    const navigateAndPrep = async function () {
      await ensurePageIsActive(page);
      await page.goto(channel.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      await setWindowBounds(page);
      await ensurePageIsActive(page);

      // Apply view scale for Kayo
      await setChromeViewScale(page, 0.25);
      await ensurePageIsActive(page);
      await delay(200);
    };

    try {
      await navigateAndPrep();
    } catch (e) {
      console.log('failed to goto/setup', channel.url, e);
      res.status(500).send('failed to goto/setup: ' + e);
      await cleanup('goto/setup failed');
      return;
    }

    // Start capture immediately after navigation
    const startCapture = async function () {
      await ensurePageIsActive(page);

      const s = await getStream(page, {
        video: true,
        audio: true,
        videoBitsPerSecond: encodingParams.videoBitsPerSecond,
        audioBitsPerSecond: encodingParams.audioBitsPerSecond,
        mimeType: encodingParams.mimeType,
        videoConstraints: {
          mandatory: {
            minWidth: viewport.width,
            minHeight: viewport.height,
            maxWidth: viewport.width,
            maxHeight: viewport.height,
            minFrameRate: encodingParams.minFrameRate,
            maxFrameRate: encodingParams.maxFrameRate,
          },
        },
      });

      s.on('error', function (err) {
        console.log('Stream error:', err);
        cleanup('stream error ' + err);
      });

      s.on('end', function () {
        console.log('Stream ended naturally');
      });

      return s;
    };

    try {
      stream = await startCapture();
      console.log('[Capture] Stream started (early):', channelName);
    } catch (e) {
      console.log('failed to start early capture', e);
      res.status(500).send('failed to start capture: ' + e);
      await cleanup('capture failed');
      return;
    }

    // Wait for stream slot
    const slotOk = await waitForStreamSlot(QUEUE_WAIT_MS);
    if (!slotOk) {
      res.status(429).send('Too many concurrent streams (timed out waiting for a slot)');
      await cleanup('queue timeout');
      return;
    }

    activeStreams++;
    cleanup._countedStream = true;
    console.log('[Streams] Active:', activeStreams);

    // Use tileClickDirect to select channel
    try {
      console.log('[Channel] Selecting:', channelName, '(' + channel.name + ')');
      const result = await selectChannelDirect(page, channel.slug);
      
      if (!result.success) {
        console.error('[Channel] Selection failed:', result.reason);
        res.status(500).send('Failed to select channel: ' + result.reason);
        await cleanup('channel select failed');
        return;
      }

      // Wait for video to be ready
      await page.waitForSelector('video', { timeout: 60000 });
      await page.waitForFunction(
        function () {
          const v = document.querySelector('video');
          if (!v) return false;
          if (v.readyState < 3) return false;
          return v.currentTime > 0.5;
        },
        { timeout: 60000 }
      );

      console.log('✅ [Channel] Playback started:', channelName);
      
      // Fullscreen toggle after playback starts
      try {
        await runKayoFullscreenToggle(page);
        // Wait for fullscreen transition and stream to stabilize before minimizing
        await delay(100);
        await minimizeWindow(page);
      } catch (e) {
        console.error('[Automation] Error during fullscreen toggle:', e);
      }
    } catch (e) {
      console.error('[Channel] Error during selection:', e);
      res.status(500).send('Channel selection error: ' + e);
      await cleanup('automation failed');
      return;
    }

    // Pipe the stream to response
    try {
      res.status(200);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');

      if (argv.outputFormat === 'mpegts') {
        // Transcode to MPEG-TS
        res.setHeader('Content-Type', 'video/mp2t');

        ffmpegProcess = spawnMpegTsTranscoder(
          encodingParams.audioBitsPerSecond,
          function (err) {
            console.error('[FFmpeg] Error:', err);
            cleanup('ffmpeg error');
          },
          channelName
        );

        console.log('[Stream] Piping WebM -> FFmpeg -> MPEG-TS for', channelName);
        stream.pipe(ffmpegProcess.stdin);
        ffmpegProcess.stdout.pipe(res);
      } else {
        // Direct WebM streaming
        res.setHeader('Content-Type', encodingParams.mimeType);
        console.log('[Stream] Piping WebM directly for', channelName);
        stream.pipe(res);
      }

      if (res.flushHeaders) res.flushHeaders();
    } catch (e) {
      console.log('failed to pipe stream', e);
      res.status(500).send('failed to pipe stream: ' + e);
      await cleanup('pipe failed');
      return;
    }
  }

  async function handleGenericStream(req, res, u) {
    // Legacy generic streaming (no channel selection)
    let page = null;
    let stream = null;
    let ffmpegProcess = null;

    const cleanup = async function (reason) {
      if (cleanup._done) return;
      cleanup._done = true;
      console.log('[cleanup]', reason);

      try { if (ffmpegProcess) ffmpegProcess.kill(); } catch (e) {}
      try { if (stream) stream.destroy(); } catch (e) {}

      if (cleanup._countedStream) {
        cleanup._countedStream = false;
        if (activeStreams > 0) activeStreams--;
        console.log('[Streams] Active:', activeStreams);
        notifyStreamSlot();
      }

      await releasePage(page, reason);
    };
    cleanup._done = false;
    cleanup._countedStream = false;

    req.on('aborted', function () { cleanup('req aborted'); });
    res.on('close', function () { cleanup('res close'); });
    res.on('error', function (err) { cleanup('res error ' + err); });

    try {
      await getCurrentBrowser();
      page = await acquirePage();
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await setWindowBounds(page);
    } catch (e) {
      console.log('failed to goto', u, e);
      res.status(500).send('failed to goto: ' + e);
      await cleanup('goto failed');
      return;
    }

    const slotOk = await waitForStreamSlot(QUEUE_WAIT_MS);
    if (!slotOk) {
      res.status(429).send('Too many concurrent streams');
      await cleanup('queue timeout');
      return;
    }

    activeStreams++;
    cleanup._countedStream = true;
    console.log('[Streams] Active:', activeStreams);

    try {
      stream = await getStream(page, {
        video: true,
        audio: true,
        videoBitsPerSecond: encodingParams.videoBitsPerSecond,
        audioBitsPerSecond: encodingParams.audioBitsPerSecond,
        mimeType: encodingParams.mimeType,
        videoConstraints: {
          mandatory: {
            minWidth: viewport.width,
            minHeight: viewport.height,
            maxWidth: viewport.width,
            maxHeight: viewport.height,
            minFrameRate: encodingParams.minFrameRate,
            maxFrameRate: encodingParams.maxFrameRate,
          },
        },
      });

      stream.on('error', function (err) {
        console.log('Stream error:', err);
        cleanup('stream error');
      });

      res.status(200);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');

      if (argv.outputFormat === 'mpegts') {
        res.setHeader('Content-Type', 'video/mp2t');

        ffmpegProcess = spawnMpegTsTranscoder(
          encodingParams.audioBitsPerSecond,
          function (err) {
            console.error('[FFmpeg] Error:', err);
            cleanup('ffmpeg error');
          },
          'generic'
        );

        stream.pipe(ffmpegProcess.stdin);
        ffmpegProcess.stdout.pipe(res);
      } else {
        res.setHeader('Content-Type', encodingParams.mimeType);
        stream.pipe(res);
      }

      if (res.flushHeaders) res.flushHeaders();
    } catch (e) {
      console.log('failed to start stream', e);
      res.status(500).send('failed to start stream: ' + e);
      await cleanup('stream failed');
    }
  }

  app.listen(argv.port, function () {
    console.log('Chrome Capture server listening on port', argv.port);
    console.log('[Streams] Max:', MAX_CONCURRENT_STREAMS, ' QueueWaitMs:', QUEUE_WAIT_MS);
    console.log('[Output] Format:', argv.outputFormat);
    console.log('[Channels] Available:', Object.keys(CHANNELS).length);
    console.log('[HDHomeRun] Emulation enabled on port', argv.port);
    console.log('[HDHomeRun] Device ID:', HDHR_DEVICE_ID);
    console.log('[HDHomeRun] To add in Plex: Enter this server address:', 'http://YOUR_IP:' + argv.port);

    // Optional: Also listen on port 5004 for standard HDHomeRun discovery
    if (argv.port !== HDHR_PORT) {
      const hdhrApp = express();
      
      // Copy HDHomeRun routes to the standard port
      if (app._router && app._router.stack) {
        hdhrApp.get('/discover.json', app._router.stack.find(r => r.route && r.route.path === '/discover.json').route.stack[0].handle);
        hdhrApp.get('/device.xml', app._router.stack.find(r => r.route && r.route.path === '/device.xml').route.stack[0].handle);
        hdhrApp.get('/lineup.json', app._router.stack.find(r => r.route && r.route.path === '/lineup.json').route.stack[0].handle);
        hdhrApp.get('/lineup_status.json', app._router.stack.find(r => r.route && r.route.path === '/lineup_status.json').route.stack[0].handle);
        hdhrApp.get('/status.json', app._router.stack.find(r => r.route && r.route.path === '/status.json').route.stack[0].handle);
        hdhrApp.post('/lineup.post', app._router.stack.find(r => r.route && r.route.path === '/lineup.post').route.stack[0].handle);
      }
      
      // Redirect stream requests to main port
      hdhrApp.get('/stream/:channelName', function (req, res) {
        res.redirect(req.protocol + '://' + req.hostname + ':' + argv.port + '/stream/' + req.params.channelName);
      });

      hdhrApp.listen(HDHR_PORT, function () {
        console.log('[HDHomeRun] Also listening on standard port', HDHR_PORT);
      }).on('error', function (err) {
        if (err.code === 'EADDRINUSE') {
          console.log('[HDHomeRun] Port', HDHR_PORT, 'already in use, using main port', argv.port, 'only');
        }
      });
    }
  });
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});