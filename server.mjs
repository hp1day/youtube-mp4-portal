import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure necessary directories exist
[UPLOADS_DIR, OUTPUTS_DIR, PUBLIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Active conversion progress event clients (SSE)
const sseClients = new Map(); // jobId -> Set of res objects

function sendSSE(jobId, data) {
  const clients = sseClients.get(jobId);
  if (clients) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => client.write(payload));
  }
}

// Utility: parse multipart or raw upload stream
async function handleFileUpload(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('multipart/form-data')) {
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      if (!boundaryMatch) {
        return reject(new Error('Invalid multipart boundary'));
      }
      const boundary = boundaryMatch[1] || boundaryMatch[2];
      const chunks = [];

      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          const boundaryBuf = Buffer.from('--' + boundary);
          const parts = [];
          
          let start = 0;
          while (start < buffer.length) {
            const index = buffer.indexOf(boundaryBuf, start);
            if (index === -1) break;
            if (start > 0) {
              parts.push(buffer.slice(start, index));
            }
            start = index + boundaryBuf.length;
          }

          const savedFiles = [];
          for (const part of parts) {
            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd === -1) continue;
            
            const headerStr = part.slice(0, headerEnd).toString('utf8');
            let body = part.slice(headerEnd + 4);
            if (body.slice(-2).toString() === '\r\n') {
              body = body.slice(0, -2);
            }

            const filenameMatch = headerStr.match(/filename="([^"]+)"/i);
            const nameMatch = headerStr.match(/name="([^"]+)"/i);

            if (filenameMatch) {
              const originalName = filenameMatch[1];
              const safeName = Date.now() + '_' + originalName.replace(/[^a-zA-Z0-9_.-]/g, '_');
              const targetPath = path.join(UPLOADS_DIR, safeName);
              fs.writeFileSync(targetPath, body);
              savedFiles.push({
                fieldName: nameMatch ? nameMatch[1] : 'file',
                originalName,
                filename: safeName,
                path: targetPath,
                size: body.length
              });
            }
          }
          resolve(savedFiles);
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    } else {
      // Direct binary body upload
      const filename = req.headers['x-file-name'] || `upload_${Date.now()}.webm`;
      const safeName = Date.now() + '_' + filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const targetPath = path.join(UPLOADS_DIR, safeName);
      const writeStream = fs.createWriteStream(targetPath);
      let size = 0;

      req.on('data', chunk => {
        size += chunk.length;
        writeStream.write(chunk);
      });
      req.on('end', () => {
        writeStream.end();
        resolve([{
          fieldName: 'file',
          originalName: filename,
          filename: safeName,
          path: targetPath,
          size
        }]);
      });
      req.on('error', reject);
    }
  });
}

// Utility: get video metadata via ffprobe
async function getMediaMetadata(filePath) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ]);
    const data = JSON.parse(stdout);
    const videoStream = data.streams?.find(s => s.codec_type === 'video');
    const audioStream = data.streams?.find(s => s.codec_type === 'audio');
    const format = data.format || {};

    return {
      duration: parseFloat(format.duration || videoStream?.duration || 0),
      size: parseInt(format.size || 0, 10),
      bitrate: parseInt(format.bit_rate || 0, 10),
      video: videoStream ? {
        codec: videoStream.codec_name,
        width: videoStream.width,
        height: videoStream.height,
        fps: eval(videoStream.r_frame_rate || '0') || 0
      } : null,
      audio: audioStream ? {
        codec: audioStream.codec_name,
        channels: audioStream.channels,
        sampleRate: audioStream.sample_rate
      } : null
    };
  } catch (err) {
    console.error('ffprobe error:', err);
    return null;
  }
}

// Helper: Parse URL query string
function parseQuery(urlStr) {
  const query = {};
  const qIdx = urlStr.indexOf('?');
  if (qIdx !== -1) {
    const pairs = urlStr.slice(qIdx + 1).split('&');
    for (const pair of pairs) {
      const [k, v] = pair.split('=');
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  return query;
}

// Request Router
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // --- SSE Endpoint for Real-time Progress ---
  if (urlPath === '/api/progress') {
    const query = parseQuery(req.url);
    const jobId = query.jobId;
    if (!jobId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'jobId is required' }));
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    if (!sseClients.has(jobId)) {
      sseClients.set(jobId, new Set());
    }
    sseClients.get(jobId).add(res);

    req.on('close', () => {
      const clients = sseClients.get(jobId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) sseClients.delete(jobId);
      }
    });
    return;
  }

  // --- API: Upload Downloaded YouTube / Video Files ---
  if (urlPath === '/api/upload' && method === 'POST') {
    try {
      const files = await handleFileUpload(req);
      if (!files.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No files uploaded' }));
      }

      // Fetch metadata for each file
      const results = [];
      for (const file of files) {
        const metadata = await getMediaMetadata(file.path);
        results.push({
          ...file,
          metadata
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, files: results }));
    } catch (err) {
      console.error('Upload handler error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message || 'File upload failed' }));
    }
  }

  // --- API: Get File Metadata ---
  if (urlPath === '/api/inspect' && method === 'GET') {
    const query = parseQuery(req.url);
    const filename = query.filename;
    if (!filename) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'filename parameter required' }));
    }

    const filePath = path.join(UPLOADS_DIR, path.basename(filename));
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'File not found' }));
    }

    const metadata = await getMediaMetadata(filePath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ filename, metadata }));
  }

  // --- API: Execute Conversion to MP4 ---
  if (urlPath === '/api/convert' && method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => bodyStr += chunk);
    req.on('end', async () => {
      try {
        const opts = JSON.parse(bodyStr || '{}');
        const {
          inputFile,
          audioFile,
          outputName,
          resolution,
          codec = 'h264',
          audioBitrate = '192k',
          startTime,
          endTime,
          jobId = `job_${Date.now()}`
        } = opts;

        if (!inputFile) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'inputFile required' }));
        }

        const inputPath = path.join(UPLOADS_DIR, path.basename(inputFile));
        if (!fs.existsSync(inputPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Input file not found' }));
        }

        const inputMetadata = await getMediaMetadata(inputPath);
        const totalDuration = inputMetadata?.duration || 1;

        const baseName = outputName
          ? outputName.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/\.[^/.]+$/, '')
          : path.basename(inputFile, path.extname(inputFile));
        
        const outFileName = `${baseName}_converted_${Date.now()}.mp4`;
        const outputPath = path.join(OUTPUTS_DIR, outFileName);

        // Build FFmpeg Arguments
        const ffmpegArgs = ['-y', '-hide_banner', '-progress', 'pipe:1'];

        // Start time trimming
        if (startTime !== undefined && startTime !== '') {
          ffmpegArgs.push('-ss', String(startTime));
        }

        ffmpegArgs.push('-i', inputPath);

        // Optional separate audio input (e.g. video.webm + audio.webm downloaded from YouTube)
        if (audioFile) {
          const audioPath = path.join(UPLOADS_DIR, path.basename(audioFile));
          if (fs.existsSync(audioPath)) {
            ffmpegArgs.push('-i', audioPath);
          }
        }

        // End time trimming
        if (endTime !== undefined && endTime !== '') {
          ffmpegArgs.push('-to', String(endTime));
        }

        // Resolution & Video Encoding settings
        if (codec === 'remux' && !resolution && !audioFile) {
          // Fast remux: stream copy video & audio directly into MP4 container
          ffmpegArgs.push('-c:v', 'copy', '-c:a', 'aac');
        } else {
          // Standard MP4 H.264 + AAC conversion
          ffmpegArgs.push('-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p');

          const vfFilters = [];
          if (resolution && resolution !== 'original') {
            if (resolution === '1080p') vfFilters.push('scale=-2:1080');
            else if (resolution === '720p') vfFilters.push('scale=-2:720');
            else if (resolution === '480p') vfFilters.push('scale=-2:480');
            else if (resolution === '360p') vfFilters.push('scale=-2:360');
          }
          if (vfFilters.length > 0) {
            ffmpegArgs.push('-vf', vfFilters.join(','));
          }

          // Audio options
          if (audioBitrate === 'mute') {
            ffmpegArgs.push('-an');
          } else {
            ffmpegArgs.push('-c:a', 'aac', '-b:a', audioBitrate || '192k');
          }
        }

        // Faststart for web playback compatibility
        ffmpegArgs.push('-movflags', '+faststart');
        ffmpegArgs.push(outputPath);

        console.log('Spawning FFmpeg:', '/usr/bin/ffmpeg', ffmpegArgs.join(' '));

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId, status: 'processing', outputFileName: outFileName }));

        // Start asynchronous FFmpeg process
        const ffmpegProc = spawn('/usr/bin/ffmpeg', ffmpegArgs);

        let progressData = {
          frame: 0,
          fps: 0,
          bitrate: '',
          totalSize: 0,
          outTimeMs: 0,
          speed: '',
          percent: 0,
          status: 'processing'
        };

        ffmpegProc.stdout.on('data', data => {
          const lines = data.toString().split('\n');
          for (const line of lines) {
            const [key, value] = line.split('=').map(s => s.trim());
            if (key === 'frame') progressData.frame = parseInt(value, 10) || 0;
            if (key === 'fps') progressData.fps = parseFloat(value) || 0;
            if (key === 'bitrate') progressData.bitrate = value;
            if (key === 'total_size') progressData.totalSize = parseInt(value, 10) || 0;
            if (key === 'speed') progressData.speed = value;
            if (key === 'out_time_us') {
              const us = parseInt(value, 10) || 0;
              const currentSec = us / 1000000;
              const percent = Math.min(99.9, Math.max(0, (currentSec / totalDuration) * 100));
              progressData.percent = parseFloat(percent.toFixed(1));
              sendSSE(jobId, { type: 'progress', ...progressData });
            }
          }
        });

        ffmpegProc.stderr.on('data', data => {
          // Send raw log lines for user inspection terminal
          sendSSE(jobId, { type: 'log', message: data.toString() });
        });

        ffmpegProc.on('close', async code => {
          if (code === 0 && fs.existsSync(outputPath)) {
            const outMeta = await getMediaMetadata(outputPath);
            sendSSE(jobId, {
              type: 'complete',
              percent: 100,
              status: 'completed',
              outFileName,
              outMeta
            });
          } else {
            sendSSE(jobId, {
              type: 'error',
              status: 'failed',
              error: `FFmpeg process exited with code ${code}`
            });
          }
        });

      } catch (err) {
        console.error('Convert error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // --- API: YouTube Link Info Extractor ---
  if (urlPath === '/api/yt-info' && method === 'GET') {
    const query = parseQuery(req.url);
    const ytUrl = query.url;

    if (!ytUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'url query parameter is required' }));
    }

    try {
      const { stdout } = await execFileAsync('/usr/bin/yt-dlp', [
        '-j',
        '--no-playlist',
        ytUrl
      ]);
      const info = JSON.parse(stdout);

      const responseData = {
        title: info.title,
        id: info.id,
        uploader: info.uploader || info.channel,
        duration: info.duration,
        thumbnail: info.thumbnail,
        description: info.description ? info.description.slice(0, 200) + '...' : '',
        formats: (info.formats || []).map(f => ({
          formatId: f.format_id,
          ext: f.ext,
          resolution: f.resolution || `${f.width}x${f.height}`,
          height: f.height,
          vcodec: f.vcodec,
          acodec: f.acodec,
          filesize: f.filesize || f.filesize_approx
        })).filter(f => f.height)
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(responseData));
    } catch (err) {
      console.error('yt-dlp info error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Failed to fetch YouTube metadata. Check URL.' }));
    }
  }

  // --- API: YouTube Link Direct Downloader & Converter ---
  if (urlPath === '/api/yt-download' && method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => bodyStr += chunk);
    req.on('end', async () => {
      try {
        const { url, resolution = '1080', jobId = `yt_${Date.now()}` } = JSON.parse(bodyStr || '{}');
        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'URL required' }));
        }

        const outFileName = `yt_download_${Date.now()}.mp4`;
        const outputPath = path.join(OUTPUTS_DIR, outFileName);

        // yt-dlp format selector: bestvideo below or equal to requested height + bestaudio, merging into mp4 container
        const formatString = resolution !== 'best'
          ? `bestvideo[height<=${resolution}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${resolution}]+bestaudio/best[height<=${resolution}]`
          : 'bestvideo+bestaudio/best';

        const args = [
          '--no-playlist',
          '-f', formatString,
          '--merge-output-format', 'mp4',
          '--recode-video', 'mp4',
          '-o', outputPath,
          url
        ];

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId, status: 'downloading', outFileName }));

        const ytProc = spawn('/usr/bin/yt-dlp', args);

        ytProc.stdout.on('data', data => {
          const str = data.toString();
          // parse yt-dlp progress string e.g., [download]  45.2% of  12.50MiB at  2.10MiB/s ETA 00:03
          const match = str.match(/\[download\]\s+([\d\.]+)%/);
          if (match) {
            const percent = parseFloat(match[1]);
            sendSSE(jobId, { type: 'progress', percent, status: 'downloading', raw: str });
          } else {
            sendSSE(jobId, { type: 'log', message: str });
          }
        });

        ytProc.stderr.on('data', data => {
          sendSSE(jobId, { type: 'log', message: data.toString() });
        });

        ytProc.on('close', async code => {
          if (code === 0 && fs.existsSync(outputPath)) {
            const outMeta = await getMediaMetadata(outputPath);
            sendSSE(jobId, {
              type: 'complete',
              percent: 100,
              status: 'completed',
              outFileName,
              outMeta
            });
          } else {
            sendSSE(jobId, {
              type: 'error',
              status: 'failed',
              error: `yt-dlp exited with error code ${code}`
            });
          }
        });

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // --- API: List Converted Files History ---
  if (urlPath === '/api/history' && method === 'GET') {
    try {
      const files = fs.readdirSync(OUTPUTS_DIR);
      const history = [];

      for (const file of files) {
        if (!file.endsWith('.mp4')) continue;
        const filePath = path.join(OUTPUTS_DIR, file);
        const stats = fs.statSync(filePath);
        history.push({
          filename: file,
          size: stats.size,
          createdTime: stats.birthtime,
          downloadUrl: `/api/download/${file}`,
          streamUrl: `/api/stream?file=${file}&type=output`
        });
      }

      history.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ history }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // --- API: Download Converted MP4 File ---
  if (urlPath.startsWith('/api/download/') && method === 'GET') {
    const filename = path.basename(urlPath.replace('/api/download/', ''));
    const filePath = path.join(OUTPUTS_DIR, filename);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('File not found');
    }

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${filename}"`
    });

    return fs.createReadStream(filePath).pipe(res);
  }

  // --- API: Stream Video Preview (Range Request Supported for Video Tag) ---
  if (urlPath === '/api/stream' && method === 'GET') {
    const query = parseQuery(req.url);
    const filename = path.basename(query.file || '');
    const isOutput = query.type === 'output';
    const targetDir = isOutput ? OUTPUTS_DIR : UPLOADS_DIR;
    const filePath = path.join(targetDir, filename);

    if (!filename || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Video not found');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4'
      });
      return file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4'
      });
      return fs.createReadStream(filePath).pipe(res);
    }
  }

  // --- Serve Static Frontend Files ---
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

// Support both primary PORT (3000) and secondary PORT (3030)
const PRIMARY_PORT = parseInt(PORT, 10);
const SECONDARY_PORT = PRIMARY_PORT === 3030 ? 3000 : 3030;

server.listen(PRIMARY_PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 YouTube MP4 Converter Portal live at http://localhost:${PRIMARY_PORT}`);
  console.log(`====================================================`);
});

// Secondary server listener on alternative port so both http://localhost:3000 and http://localhost:3030 work
const secondaryServer = http.createServer((req, res) => server.emit('request', req, res));
secondaryServer.listen(SECONDARY_PORT, '0.0.0.0', () => {
  console.log(`🚀 Alternative portal access live at http://localhost:${SECONDARY_PORT}`);
}).on('error', (err) => {
  console.log(`Notice: Secondary port ${SECONDARY_PORT} listener skipped (${err.message})`);
});

