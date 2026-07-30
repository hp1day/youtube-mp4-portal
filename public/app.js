// YouTube MP4 Portal Client Application

function apiUrl(endpoint) {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return endpoint;
  }
  const base = localStorage.getItem('yt_portal_backend') || 'http://localhost:3000';
  return base.replace(/\/$/, '') + endpoint;
}

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');

  const configCard = document.getElementById('config-card');
  const previewVideo = document.getElementById('previewVideo');
  const metaRes = document.getElementById('metaRes');
  const metaCodec = document.getElementById('metaCodec');
  const metaDuration = document.getElementById('metaDuration');
  const metaSize = document.getElementById('metaSize');

  const conversionMode = document.getElementById('conversionMode');
  const resSelect = document.getElementById('resSelect');
  const audioBitrateSelect = document.getElementById('audioBitrateSelect');
  const trimStart = document.getElementById('trimStart');
  const trimEnd = document.getElementById('trimEnd');
  const outputFilename = document.getElementById('outputFilename');
  const startConvertBtn = document.getElementById('startConvertBtn');

  const progressCard = document.getElementById('progressCard');
  const progressTitle = document.getElementById('progressTitle');
  const progressPercentBadge = document.getElementById('progressPercentBadge');
  const progressBarFill = document.getElementById('progressBarFill');
  const metricSpeed = document.getElementById('metricSpeed');
  const metricFps = document.getElementById('metricFps');
  const metricBitrate = document.getElementById('metricBitrate');
  const metricFrames = document.getElementById('metricFrames');
  const terminalBox = document.getElementById('terminalBox');

  const completeBox = document.getElementById('completeBox');
  const convertedVideoPreview = document.getElementById('convertedVideoPreview');
  const downloadMp4Btn = document.getElementById('downloadMp4Btn');
  const convertAnotherBtn = document.getElementById('convertAnotherBtn');

  const ytUrlInput = document.getElementById('ytUrlInput');
  const ytFetchBtn = document.getElementById('ytFetchBtn');
  const ytInfoCard = document.getElementById('ytInfoCard');
  const ytThumb = document.getElementById('ytThumb');
  const ytTitle = document.getElementById('ytTitle');
  const ytUploader = document.getElementById('ytUploader');
  const ytResSelect = document.getElementById('ytResSelect');
  const ytStartDownloadBtn = document.getElementById('ytStartDownloadBtn');

  const historyTableBody = document.getElementById('historyTableBody');

  // State Variables
  let uploadedFiles = [];
  let currentFile = null;
  let activeEventSource = null;

  // --- Tab Navigation ---
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetTab = btn.getAttribute('data-tab');
      document.getElementById(targetTab).classList.add('active');

      if (targetTab === 'tab-history') {
        loadHistory();
      }
    });
  });

  // --- Drag and Drop Handlers ---
  dropzone.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', e => {
    const files = e.dataTransfer.files;
    if (files.length) {
      handleFilesUpload(files);
    }
  });

  fileInput.addEventListener('change', e => {
    if (e.target.files.length) {
      handleFilesUpload(e.target.files);
    }
  });

  // Upload handler
  async function handleFilesUpload(files) {
    showToast('Uploading file for analysis...', 'info');

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    try {
      const res = await fetch(apiUrl('/api/upload'), {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (data.success && data.files.length) {
        uploadedFiles = data.files;
        currentFile = data.files[0];
        displayFileInfo(currentFile);
        showToast('File uploaded & analyzed successfully!', 'success');
      } else {
        showToast(data.error || 'Upload failed', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Error uploading file', 'error');
    }
  }

  // Display File Metadata in UI Inspector
  function displayFileInfo(fileObj) {
    configCard.style.display = 'block';
    configCard.scrollIntoView({ behavior: 'smooth' });

    const meta = fileObj.metadata || {};
    const video = meta.video || {};

    // Stream original video preview
    previewVideo.src = apiUrl(`/api/stream?file=${fileObj.filename}&type=upload`);

    metaRes.textContent = video.width ? `${video.width}x${video.height}` : 'Audio Only / Unknown';
    metaCodec.textContent = (video.codec || 'Unknown').toUpperCase();
    metaDuration.textContent = formatDuration(meta.duration || 0);
    metaSize.textContent = formatBytes(fileObj.size || 0);

    // Auto-fill default output name
    const defaultName = fileObj.originalName.replace(/\.[^/.]+$/, '');
    outputFilename.value = defaultName;
  }

  // --- Start Local Conversion Handler ---
  startConvertBtn.addEventListener('click', async () => {
    if (!currentFile) return;

    const jobId = `job_${Date.now()}`;
    const payload = {
      jobId,
      inputFile: currentFile.filename,
      outputName: outputFilename.value,
      resolution: resSelect.value,
      codec: conversionMode.value,
      audioBitrate: audioBitrateSelect.value,
      startTime: trimStart.value,
      endTime: trimEnd.value
    };

    // If second file uploaded (e.g. video.webm + audio.webm downloaded from YouTube)
    if (uploadedFiles.length > 1) {
      payload.audioFile = uploadedFiles[1].filename;
    }

    startConversionMonitor(jobId, 'Converting YouTube video to MP4...');

    try {
      const res = await fetch(apiUrl('/api/convert'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.error) {
        showToast(data.error, 'error');
        resetProgressCard();
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to start conversion request', 'error');
      resetProgressCard();
    }
  });

  // --- Real-time Progress Monitor SSE Listener ---
  function startConversionMonitor(jobId, titleText) {
    progressCard.style.display = 'block';
    completeBox.style.display = 'none';
    progressTitle.textContent = titleText;
    progressBarFill.style.width = '0%';
    progressPercentBadge.textContent = '0%';
    terminalBox.textContent = 'Initiating FFmpeg pipeline...\n';

    progressCard.scrollIntoView({ behavior: 'smooth' });

    if (activeEventSource) {
      activeEventSource.close();
    }

    activeEventSource = new EventSource(apiUrl(`/api/progress?jobId=${jobId}`));

    activeEventSource.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);

        if (msg.type === 'progress') {
          const pct = Math.min(100, Math.max(0, msg.percent || 0));
          progressBarFill.style.width = `${pct}%`;
          progressPercentBadge.textContent = `${pct}%`;

          if (msg.speed) metricSpeed.textContent = msg.speed;
          if (msg.fps) metricFps.textContent = msg.fps;
          if (msg.bitrate) metricBitrate.textContent = msg.bitrate;
          if (msg.frame) metricFrames.textContent = msg.frame;

        } else if (msg.type === 'log') {
          terminalBox.textContent += msg.message;
          terminalBox.scrollTop = terminalBox.scrollHeight;

        } else if (msg.type === 'complete') {
          activeEventSource.close();
          progressBarFill.style.width = '100%';
          progressPercentBadge.textContent = '100%';

          showToast('Conversion finished!', 'success');
          setTimeout(() => {
            progressCard.style.display = 'none';
            displayCompletedState(msg.outFileName);
          }, 800);

        } else if (msg.type === 'error') {
          activeEventSource.close();
          showToast(msg.error || 'Conversion error occurred', 'error');
          terminalBox.textContent += `\n[ERROR] ${msg.error}`;
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    activeEventSource.onerror = () => {
      console.warn('SSE connection closed or lost');
    };
  }

  function resetProgressCard() {
    progressCard.style.display = 'none';
    if (activeEventSource) activeEventSource.close();
  }

  // --- Display Completed Video State ---
  function displayCompletedState(outFileName) {
    completeBox.style.display = 'block';
    completeBox.scrollIntoView({ behavior: 'smooth' });

    convertedVideoPreview.src = apiUrl(`/api/stream?file=${outFileName}&type=output`);
    downloadMp4Btn.href = apiUrl(`/api/download/${outFileName}`);
    downloadMp4Btn.setAttribute('download', outFileName);
  }

  convertAnotherBtn.addEventListener('click', () => {
    completeBox.style.display = 'none';
    configCard.style.display = 'none';
    uploadedFiles = [];
    currentFile = null;
    fileInput.value = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // --- TAB 2: YouTube URL Downloader Logic ---
  let fetchedYtUrl = '';

  ytFetchBtn.addEventListener('click', async () => {
    const url = ytUrlInput.value.trim();
    if (!url) {
      showToast('Please enter a valid YouTube URL', 'error');
      return;
    }

    showToast('Fetching YouTube metadata...', 'info');
    ytFetchBtn.disabled = true;
    ytFetchBtn.textContent = 'Fetching...';

    let data = null;

    // First try backend API
    try {
      const res = await fetch(apiUrl(`/api/yt-info?url=${encodeURIComponent(url)}`));
      if (res.ok) {
        data = await res.json();
      }
    } catch (err) {
      console.warn('Backend yt-info unavailable, using HTTPS metadata fallback...', err);
    }

    // Fallback for GitHub Pages static environment (HTTPS CORS)
    if (!data || data.error) {
      try {
        const videoIdMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
        if (videoIdMatch && videoIdMatch[1]) {
          const videoId = videoIdMatch[1];
          const noembedRes = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
          if (noembedRes.ok) {
            const noembedData = await noembedRes.json();
            data = {
              title: noembedData.title || 'YouTube Video',
              uploader: noembedData.author_name || 'YouTube Creator',
              thumbnail: noembedData.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
              duration: 0
            };
          }
        }
      } catch (fallbackErr) {
        console.error('Fallback failed:', fallbackErr);
      }
    }

    ytFetchBtn.disabled = false;
    ytFetchBtn.textContent = 'Fetch Link';

    if (data && data.title) {
      fetchedYtUrl = url;
      ytTitle.textContent = data.title;
      ytUploader.textContent = `${data.uploader || 'YouTube Channel'}${data.duration ? ' • ' + formatDuration(data.duration) : ''}`;
      ytThumb.src = data.thumbnail || '';
      ytInfoCard.style.display = 'block';
      showToast('YouTube link analyzed successfully!', 'success');
    } else {
      showToast('Failed to fetch YouTube info. Please check the URL.', 'error');
    }
  });

  ytStartDownloadBtn.addEventListener('click', async () => {
    if (!fetchedYtUrl) return;

    const jobId = `yt_${Date.now()}`;
    const payload = {
      jobId,
      url: fetchedYtUrl,
      resolution: ytResSelect.value
    };

    startConversionMonitor(jobId, 'Downloading & Converting YouTube URL to MP4...');

    try {
      const res = await fetch(apiUrl('/api/yt-download'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.error) {
        showToast(data.error, 'error');
        resetProgressCard();
      }
    } catch (err) {
      console.warn('Backend server unreachable, redirecting to direct downloader...', err);
      resetProgressCard();

      const videoIdMatch = fetchedYtUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
      const videoId = videoIdMatch ? videoIdMatch[1] : '';
      const downloadUrl = `https://ssyoutube.com/watch?v=${videoId || encodeURIComponent(fetchedYtUrl)}`;

      showToast('Opening high-speed MP4 download service...', 'info');
      window.open(downloadUrl, '_blank');
    }
  });

  // --- TAB 3: History & Downloads Library ---
  async function loadHistory() {
    try {
      const res = await fetch(apiUrl('/api/history'));
      const data = await res.json();

      historyTableBody.innerHTML = '';

      if (!data.history || !data.history.length) {
        historyTableBody.innerHTML = `
          <tr>
            <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">
              No converted videos yet. Convert a YouTube video above!
            </td>
          </tr>`;
        return;
      }

      data.history.forEach(item => {
        const tr = document.createElement('tr');
        const formattedDate = new Date(item.createdTime).toLocaleString();
        
        tr.innerHTML = `
          <td style="font-weight: 600; color: var(--text-main);">${escapeHtml(item.filename)}</td>
          <td>${formatBytes(item.size)}</td>
          <td style="color: var(--text-muted); font-size: 0.85rem;">${formattedDate}</td>
          <td>
            <a href="${item.downloadUrl}" class="btn-icon" download style="text-decoration: none; margin-right: 6px;">
              💾 Download
            </a>
            <button class="btn-icon preview-hist-btn" data-url="${item.streamUrl}">
              ▶️ Play
            </button>
          </td>
        `;
        historyTableBody.appendChild(tr);
      });

      document.querySelectorAll('.preview-hist-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          const streamUrl = e.target.getAttribute('data-url');
          convertedVideoPreview.src = streamUrl;
          completeBox.style.display = 'block';
          completeBox.scrollIntoView({ behavior: 'smooth' });
        });
      });

    } catch (err) {
      console.error(err);
      showToast('Failed to load conversion history', 'error');
    }
  }

  // --- Utility Helpers ---
  function formatBytes(bytes) {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function formatDuration(sec) {
    const s = Math.round(sec);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  function showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const colors = {
      success: '#10b981',
      error: '#ef4444',
      info: '#3b82f6'
    };
    toast.style.borderColor = colors[type] || colors.info;

    toast.textContent = message;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }
});
