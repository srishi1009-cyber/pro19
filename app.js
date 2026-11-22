"use strict";

/* ============================================================
   RISHI MUSIC — FULL ENGINE (merged + fixed + AI Voice DJ + Live AI Lyrics)
   ============================================================ */

/* 1. SERVICE WORKER */
if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
        navigator.serviceWorker.register("./sw.js").catch(function (err) {
            console.error("[Rishi Music] SW Registration Failed:", err);
        });
    });
}

/* 2. INDEXEDDB */
const DB_NAME = "RishiMusicDB_v4";
const DB_VERSION = 1;
const STORE_NAME = "audio_library";
let db = null;

function initDB() {
    return new Promise(function (resolve, reject) {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function (e) {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };
        request.onsuccess = function () { db = request.result; resolve(db); };
        request.onerror = function () { reject(request.error); };
    });
}

function getAllTracksMetadata() {
    return new Promise(function (resolve) {
        if (!db) return resolve([]);
        const store = db.transaction([STORE_NAME], "readonly").objectStore(STORE_NAME);
        const metadata = [];
        const req = store.openCursor();
        req.onsuccess = function (e) {
            const cursor = e.target.result;
            if (cursor) {
                metadata.push({ id: cursor.value.id, title: cursor.value.title, director: cursor.value.director });
                cursor.continue();
            } else resolve(metadata);
        };
        req.onerror = function () { resolve([]); };
    });
}

function getTrackAudioBlob(id) {
    return new Promise(function (resolve, reject) {
        if (!db) return reject(new Error("DB closed"));
        const req = db.transaction([STORE_NAME], "readonly").objectStore(STORE_NAME).get(id);
        req.onsuccess = function () { resolve(req.result ? req.result.blob : null); };
        req.onerror = function () { reject(req.error); };
    });
}

function saveTracksBatch(trackList) {
    return new Promise(function (resolve, reject) {
        if (!db || !trackList.length) return resolve();
        const tx = db.transaction([STORE_NAME], "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (let i = 0; i < trackList.length; i++) store.put(trackList[i]);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function (e) { reject(e); };
    });
}

function removeTrackFromDB(id) {
    return new Promise(function (resolve) {
        if (!db) return resolve();
        const tx = db.transaction([STORE_NAME], "readwrite");
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = function () { resolve(); };
    });
}

/* 3. STATE */
let tracks = [];
let currentTrackIndex = -1;
let currentBlobUrl = null;
let playHistory = [];
let userManuallyPaused = false;
let isSwitchingSong = false;
let activeEditingTrackId = null;
let deferredPrompt = null;
let pendingImportFiles = [];
const BATCH_SIZE = 40;
let renderedCount = 0;
let filteredTrackIndices = [];

/* 4. DOM */
const audio = document.getElementById("audioEl");
const tracksContainer = document.getElementById("tracksContainer");
const searchInput = document.getElementById("searchInput");
const directorFilter = document.getElementById("directorFilter");
const importBtn = document.getElementById("importBtn");
const fileSelector = document.getElementById("fileSelector");
const mainPlayBtn = document.getElementById("mainPlayBtn");
const mainPlayIcon = document.getElementById("mainPlayIcon");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const progressBar = document.getElementById("progressBar");
const currentTimeEl = document.getElementById("currentTime");
const durationEl = document.getElementById("duration");
const dockTitle = document.getElementById("dockTitle");
const dockSubtitle = document.getElementById("dockSubtitle");
const installBar = document.getElementById("installBar");
const installTriggerBtn = document.getElementById("installTriggerBtn");
const editModal = document.getElementById("editModal");
const editTitleInput = document.getElementById("editTitleInput");
const editDirectorInput = document.getElementById("editDirectorInput");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const saveEditBtn = document.getElementById("saveEditBtn");
const bulkDirectorModal = document.getElementById("bulkDirectorModal");
const bulkDirectorInput = document.getElementById("bulkDirectorInput");
const skipBulkDirectorBtn = document.getElementById("skipBulkDirectorBtn");
const saveBulkDirectorBtn = document.getElementById("saveBulkDirectorBtn");

function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

/* 5. DAILY ROTATION */
function getTodayDateString() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function getDailyLog() {
    const today = getTodayDateString();
    try {
        const raw = localStorage.getItem("rishi_daily_plays_v4");
        let parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || parsed.date !== today || !Array.isArray(parsed.playedIds)) {
            parsed = { date: today, playedIds: [] };
            localStorage.setItem("rishi_daily_plays_v4", JSON.stringify(parsed));
        }
        return parsed;
    } catch (e) {
        return { date: today, playedIds: [] };
    }
}

function saveDailyLog(log) {
    try { localStorage.setItem("rishi_daily_plays_v4", JSON.stringify(log)); }
    catch (e) { console.warn("Storage error:", e); }
}

function markSongAsPlayed(songId) {
    const log = getDailyLog();
    if (!log.playedIds.includes(songId)) log.playedIds.push(songId);
    saveDailyLog(log);
    renderTrackList(false);
}

function getNextUnplayedIndex() {
    if (tracks.length === 0) return -1;
    const selectedDirector = directorFilter ? directorFilter.value : "ALL";
    const playedSet = new Set(getDailyLog().playedIds);
    const pool = [];
    for (let i = 0; i < tracks.length; i++) {
        if (selectedDirector === "ALL" || tracks[i].director === selectedDirector) pool.push(i);
    }
    if (!pool.length) return -1;
    const unplayed = pool.filter(function (idx) {
        return !playedSet.has(tracks[idx].id) && idx !== currentTrackIndex;
    });
    if (!unplayed.length) return -1;
    return unplayed[Math.floor(Math.random() * unplayed.length)];
}

/* 6. MEDIA SESSION */
function updateMediaSession(track) {
    if (!("mediaSession" in navigator) || !track) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.director, album: "Rishi Music" });
        navigator.mediaSession.setActionHandler("play", function () { userManuallyPaused = false; playCurrentTrack(); });
        navigator.mediaSession.setActionHandler("pause", function () { pauseCurrentTrack(); });
        navigator.mediaSession.setActionHandler("nexttrack", function () { userManuallyPaused = false; advanceToNextTrack(); });
        navigator.mediaSession.setActionHandler("previoustrack", function () { userManuallyPaused = false; playPreviousTrack(); });
        navigator.mediaSession.setActionHandler("seekto", function (e) {
            if (e.seekTime && Number.isFinite(e.seekTime)) audio.currentTime = e.seekTime;
        });
    } catch (e) { console.warn("MediaSession error:", e); }
}

/* 7. PLAYBACK */
async function loadTrackSource(index) {
    if (index < 0 || index >= tracks.length) return false;
    currentTrackIndex = index;
    const track = tracks[currentTrackIndex];
    if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
    const blob = await getTrackAudioBlob(track.id);
    if (!blob) { console.error("Audio data missing for track:", track); return false; }
    currentBlobUrl = URL.createObjectURL(blob);
    audio.pause();
    audio.src = currentBlobUrl;
    audio.playbackRate = Number(appSettings.speed) || 1;
    dockTitle.textContent = track.title;
    dockSubtitle.textContent = track.director;
    currentTimeEl.textContent = "0:00";
    durationEl.textContent = "0:00";
    progressBar.value = 0;
    updateMediaSession(track);
    renderTrackList(false);
    return true;
}

async function playCurrentTrack() {
    if (currentTrackIndex === -1 && tracks.length > 0) {
        const firstIdx = getNextUnplayedIndex();
        if (firstIdx === -1) {
            alert("All songs in this selection have been played today! Tap any song voluntarily to replay.");
            return;
        }
        await loadTrackSource(firstIdx);
    }
    const track = tracks[currentTrackIndex];
    if (!track) return;
    userManuallyPaused = false;
    try {
        await audio.play();
        setPlayIconState(true);
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
        renderTrackList(false);
    } catch (error) {
        console.warn("Playback prevented or deferred:", error);
        setPlayIconState(false);
    }
}

function pauseCurrentTrack() {
    userManuallyPaused = true;
    audio.pause();
    setPlayIconState(false);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    renderTrackList(false);
}

async function advanceToNextTrack() {
    if (isSwitchingSong || tracks.length === 0) return;
    isSwitchingSong = true;
    userManuallyPaused = false;
    if (currentTrackIndex !== -1) {
        playHistory.push(currentTrackIndex);
        if (playHistory.length > 50) playHistory.shift();
    }
    const nextIndex = getNextUnplayedIndex();
    if (nextIndex === -1) {
        pauseCurrentTrack();
        dockTitle.textContent = "Finished for today";
        dockSubtitle.textContent = "All songs played. Tap any song voluntarily to replay.";
        isSwitchingSong = false;
        return;
    }
    const loaded = await loadTrackSource(nextIndex);
    if (loaded) await playCurrentTrack();
    isSwitchingSong = false;
}

async function playPreviousTrack() {
    if (tracks.length === 0) return;
    userManuallyPaused = false;
    if (audio.currentTime > 3) { audio.currentTime = 0; await playCurrentTrack(); return; }
    if (playHistory.length > 0) {
        await loadTrackSource(playHistory.pop());
        await playCurrentTrack();
    } else {
        audio.currentTime = 0;
        await playCurrentTrack();
    }
}

/* 8. AUDIO EVENTS */
audio.addEventListener("ended", function () {
    if (userManuallyPaused || isSwitchingSong) return;
    const t = tracks[currentTrackIndex];
    if (t) markSongAsPlayed(t.id);
    advanceToNextTrack();
});

audio.addEventListener("error", function () {
    if (userManuallyPaused || isSwitchingSong) return;
    advanceToNextTrack();
});

audio.addEventListener("pause", function () {
    if (!userManuallyPaused && !audio.ended && !isSwitchingSong) {
        setTimeout(function () {
            if (!userManuallyPaused && audio.paused) audio.play().catch(function () {});
        }, 400);
    }
});

audio.addEventListener("timeupdate", function () {
    if (!audio.duration) return;
    progressBar.value = (audio.currentTime / audio.duration) * 100;
    currentTimeEl.textContent = formatTime(audio.currentTime);
    durationEl.textContent = formatTime(audio.duration);
});

progressBar.addEventListener("input", function () {
    if (audio.duration) audio.currentTime = (Number(progressBar.value) / 100) * audio.duration;
});

function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    return Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
}

function setPlayIconState(isPlaying) {
    if (!mainPlayIcon) return;
    mainPlayIcon.innerHTML = isPlaying
        ? '<rect x="6" y="4" width="4" height="16" fill="#ffffff"></rect><rect x="14" y="4" width="4" height="16" fill="#ffffff"></rect>'
        : '<polygon points="6,4 20,12 6,20"></polygon>';
}

/* 9. VIRTUAL PAGINATION */
function computeFilteredList() {
    const query = String(searchInput.value || "").trim().toLowerCase();
    const filter = directorFilter.value || "ALL";
    filteredTrackIndices = [];
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const matchSearch = t.title.toLowerCase().includes(query) || t.director.toLowerCase().includes(query);
        const matchDirector = filter === "ALL" || t.director === filter;
        if (matchSearch && matchDirector) filteredTrackIndices.push(i);
    }
}

const PLAY_SVG = '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"></polygon></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';

function appendTrackCards(count) {
    const playedSet = new Set(getDailyLog().playedIds);
    const endIndex = Math.min(renderedCount + count, filteredTrackIndices.length);
    for (let i = renderedCount; i < endIndex; i++) {
        const idx = filteredTrackIndices[i];
        const track = tracks[idx];
        const isCurrent = idx === currentTrackIndex;
        const isPlaying = isCurrent && !audio.paused;
        const isPlayedToday = playedSet.has(track.id);
        const card = document.createElement("div");
        card.className = "track-card" + (isCurrent ? " active" : "") + (isPlayedToday ? " played-today" : "");
        card.innerHTML =
            '<div class="track-main"><span class="music-glyph">♬</span><div class="track-text">' +
            '<div class="track-name">' + esc(track.title) + '</div>' +
            '<div class="track-sub">' + esc(track.director) +
            (isPlayedToday ? '<span class="daily-status"> Played Today</span>' : "") + '</div></div></div>' +
            '<div class="track-actions">' +
            '<button class="edit-btn" data-action="edit" data-id="' + esc(track.id) + '">Edit</button>' +
            '<button class="delete-btn" data-action="delete" data-id="' + esc(track.id) + '">🗑</button>' +
            '<button class="card-play-btn" data-action="play" data-idx="' + idx + '">' + (isPlaying ? PAUSE_SVG : PLAY_SVG) + '</button></div>';
        tracksContainer.appendChild(card);
    }
    renderedCount = endIndex;
}

function renderTrackList(resetList) {
    if (resetList === undefined) resetList = true;
    if (!tracksContainer) return;
    if (resetList) {
        computeFilteredList();
        tracksContainer.innerHTML = "";
        renderedCount = 0;
    }
    if (tracks.length === 0) {
        tracksContainer.innerHTML = '<div class="empty-state">Your library is empty.<br>Click <strong>+ Import Track</strong> above to add songs.</div>';
        return;
    }
    if (resetList) {
        appendTrackCards(BATCH_SIZE);
    } else {
        const playedSet = new Set(getDailyLog().playedIds);
        tracksContainer.querySelectorAll(".track-card").forEach(function (card, domIdx) {
            const trackIdx = filteredTrackIndices[domIdx];
            if (trackIdx === undefined) return;
            const track = tracks[trackIdx];
            const isCurrent = trackIdx === currentTrackIndex;
            card.className = "track-card" + (isCurrent ? " active" : "") + (playedSet.has(track.id) ? " played-today" : "");
            const playBtn = card.querySelector(".card-play-btn");
            if (playBtn) playBtn.innerHTML = (isCurrent && !audio.paused) ? PAUSE_SVG : PLAY_SVG;
        });
    }
}

window.addEventListener("scroll", function () {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
        if (renderedCount < filteredTrackIndices.length) appendTrackCards(BATCH_SIZE);
    }
});

function updateDirectorDropdown() {
    const cur = directorFilter.value || "ALL";
    const dirs = Array.from(new Set(tracks.map(function (t) { return t.director; }))).filter(Boolean).sort();
    directorFilter.innerHTML = '<option value="ALL">ALL DIRECTORS</option>';
    dirs.forEach(function (d) {
        const opt = document.createElement("option");
        opt.value = d; opt.textContent = d;
        directorFilter.appendChild(opt);
    });
    directorFilter.value = dirs.indexOf(cur) >= 0 ? cur : "ALL";
}

/* 10. CARD ACTIONS */
tracksContainer.addEventListener("click", async function (e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    e.stopPropagation();
    const action = btn.dataset.action;

    if (action === "play") {
        const idx = Number(btn.dataset.idx);
        if (idx === currentTrackIndex) {
            if (audio.paused) await playCurrentTrack(); else pauseCurrentTrack();
        } else {
            await loadTrackSource(idx);
            await playCurrentTrack();
        }
    } else if (action === "edit") {
        const track = tracks.find(function (t) { return t.id === btn.dataset.id; });
        if (!track) return;
        activeEditingTrackId = track.id;
        editTitleInput.value = track.title;
        editDirectorInput.value = track.director;
        editModal.classList.add("open");
    } else if (action === "delete") {
        const track = tracks.find(function (t) { return t.id === btn.dataset.id; });
        if (!track || !confirm('Delete "' + track.title + '"?')) return;
        await removeTrackFromDB(track.id);
        const idx = tracks.indexOf(track);
        if (idx === currentTrackIndex) {
            audio.pause();
            currentTrackIndex = -1;
            dockTitle.textContent = "No track playing";
            dockSubtitle.textContent = "Select a song from your library";
            setPlayIconState(false);
        } else if (idx < currentTrackIndex) {
            currentTrackIndex--;
        }
        tracks.splice(idx, 1);
        updateDirectorDropdown();
        renderTrackList(true);
    }
});

cancelEditBtn.addEventListener("click", function () {
    editModal.classList.remove("open");
    activeEditingTrackId = null;
});

saveEditBtn.addEventListener("click", async function () {
    if (!activeEditingTrackId) return;
    const track = tracks.find(function (t) { return t.id === activeEditingTrackId; });
    if (!track) return;
    const t = editTitleInput.value.trim();
    const d = editDirectorInput.value.trim();
    if (!t) { alert("Title cannot be empty."); return; }
    track.title = t;
    track.director = d || "UNKNOWN DIRECTOR";
    const blob = await getTrackAudioBlob(track.id);
    await saveTracksBatch([{ id: track.id, title: track.title, director: track.director, blob: blob }]);
    if (tracks[currentTrackIndex] && tracks[currentTrackIndex].id === track.id) {
        dockTitle.textContent = track.title;
        dockSubtitle.textContent = track.director;
    }
    editModal.classList.remove("open");
    activeEditingTrackId = null;
    updateDirectorDropdown();
    renderTrackList(true);
});

/* 11. BULK IMPORT */
importBtn.addEventListener("click", function () {
    fileSelector.value = "";
    fileSelector.click();
});

fileSelector.addEventListener("change", function (e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    pendingImportFiles = files;
    if (bulkDirectorModal) {
        bulkDirectorInput.value = "";
        bulkDirectorModal.classList.add("open");
    } else {
        const entered = prompt("Enter Music Director for selected song(s):", "UNKNOWN DIRECTOR");
        processImportQueue(entered && entered.trim() ? entered.trim() : "UNKNOWN DIRECTOR");
    }
});

if (skipBulkDirectorBtn) {
    skipBulkDirectorBtn.addEventListener("click", function () {
        bulkDirectorModal.classList.remove("open");
        processImportQueue("UNKNOWN DIRECTOR");
    });
}

if (saveBulkDirectorBtn) {
    saveBulkDirectorBtn.addEventListener("click", function () {
        const name = bulkDirectorInput.value.trim() || "UNKNOWN DIRECTOR";
        bulkDirectorModal.classList.remove("open");
        processImportQueue(name);
    });
}

async function processImportQueue(musicDirector) {
    if (!pendingImportFiles.length) return;
    importBtn.disabled = true;
    const total = pendingImportFiles.length;
    let savedCount = 0;
    const CHUNK_SIZE = 15;
    for (let i = 0; i < total; i += CHUNK_SIZE) {
        const chunk = pendingImportFiles.slice(i, i + CHUNK_SIZE);
        const batchRecords = [];
        for (let j = 0; j < chunk.length; j++) {
            const f = chunk[j];
            const rec = {
                id: "track_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9),
                title: f.name.replace(/\.[^.]+$/, ""),
                director: musicDirector,
                blob: f
            };
            batchRecords.push(rec);
            tracks.push({ id: rec.id, title: rec.title, director: rec.director });
            savedCount++;
        }
        importBtn.textContent = "Saving (" + savedCount + "/" + total + ")...";
        await saveTracksBatch(batchRecords);
        await new Promise(function (r) { setTimeout(r, 40); });
    }
    pendingImportFiles = [];
    importBtn.disabled = false;
    importBtn.textContent = "+ Import Track";
    fileSelector.value = "";
    updateDirectorDropdown();
    renderTrackList(true);
}

/* 12. BOTTOM CONTROLS */
mainPlayBtn.addEventListener("click", async function () {
    if (audio.paused) await playCurrentTrack(); else pauseCurrentTrack();
});
prevBtn.addEventListener("click", playPreviousTrack);
nextBtn.addEventListener("click", advanceToNextTrack);
searchInput.addEventListener("input", function () { renderTrackList(true); });
directorFilter.addEventListener("change", function () { renderTrackList(true); });

/* 13. PWA INSTALL */
function isAppInstalled() {
    return window.matchMedia("(display-mode: standalone)").matches ||
           window.matchMedia("(display-mode: minimal-ui)").matches ||
           window.matchMedia("(display-mode: fullscreen)").matches ||
           window.navigator.standalone === true ||
           localStorage.getItem("rishi_pwa_installed") === "true";
}

function hideInstallBar() {
    if (installBar) installBar.style.display = "none";
}

if (isAppInstalled()) {
    hideInstallBar();
}

window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    if (isAppInstalled()) {
        hideInstallBar();
        return;
    }
    deferredPrompt = e;
    if (installBar) installBar.style.display = "flex";
});

window.addEventListener("appinstalled", function () {
    localStorage.setItem("rishi_pwa_installed", "true");
    hideInstallBar();
    deferredPrompt = null;
});

if (installTriggerBtn) {
    installTriggerBtn.addEventListener("click", async function () {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const res = await deferredPrompt.userChoice;
        if (res.outcome === "accepted") {
            localStorage.setItem("rishi_pwa_installed", "true");
            hideInstallBar();
        }
        deferredPrompt = null;
    });
}

/* 14. SETTINGS */
const SETTINGS_KEY = "rishi_settings_v1";
const DEFAULT_SETTINGS = { theme: "dark", accent: "#1d72fe", speed: 1, volume: 100 };
let appSettings = loadAppSettings();

function loadAppSettings() {
    try {
        return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
    } catch (error) { return Object.assign({}, DEFAULT_SETTINGS); }
}

function saveAppSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings)); }
    catch (error) { console.warn("Could not save settings:", error); }
}

function hexToRgb(hex) {
    const clean = String(hex).replace("#", "");
    const full = clean.length === 3 ? clean.split("").map(function (c) { return c + c; }).join("") : clean;
    const n = parseInt(full, 16);
    if (!Number.isFinite(n)) return "29,114,254";
    return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
}

function applyAppSettings() {
    document.body.dataset.theme = appSettings.theme === "light" ? "light" : "dark";
    document.documentElement.style.setProperty("--accent", appSettings.accent);
    document.documentElement.style.setProperty("--accent-rgb", hexToRgb(appSettings.accent));
    audio.playbackRate = Number(appSettings.speed) || 1;
    audio.volume = Math.max(0, Math.min(1, Number(appSettings.volume) / 100));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = appSettings.theme === "light" ? "#f4f7fb" : "#08090d";
}

const settingsModal = document.getElementById("settingsModal");
const settingsBtn = document.getElementById("settingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const doneSettingsBtn = document.getElementById("doneSettingsBtn");
const resetSettingsBtn = document.getElementById("resetSettingsBtn");
const themeSelect = document.getElementById("themeSelect");
const accentColor = document.getElementById("accentColor");
const accentHex = document.getElementById("accentHex");
const playbackSpeed = document.getElementById("playbackSpeed");
const defaultVolume = document.getElementById("defaultVolume");
const volumeValue = document.getElementById("volumeValue");
const settingsTrackCount = document.getElementById("settingsTrackCount");
const storageUsage = document.getElementById("storageUsage");

function openSettings() {
    if (!settingsModal) return;
    themeSelect.value = appSettings.theme;
    accentColor.value = appSettings.accent;
    accentHex.value = appSettings.accent.toUpperCase();
    playbackSpeed.value = String(appSettings.speed);
    defaultVolume.value = String(appSettings.volume);
    volumeValue.textContent = appSettings.volume + "%";
    if (settingsTrackCount) settingsTrackCount.textContent = String(tracks.length);
    settingsModal.classList.add("open");
    settingsModal.setAttribute("aria-hidden", "false");
    updateStorageEstimate();
}

function closeSettings() {
    if (!settingsModal) return;
    settingsModal.classList.remove("open");
    settingsModal.setAttribute("aria-hidden", "true");
}

function updateSetting(changes) {
    appSettings = Object.assign({}, appSettings, changes);
    saveAppSettings();
    applyAppSettings();
}

function updateStorageEstimate() {
    if (!storageUsage) return;
    if (!navigator.storage || !navigator.storage.estimate) {
        storageUsage.textContent = "Not available in this browser";
        return;
    }
    navigator.storage.estimate().then(function (info) {
        const mb = Number(info.usage || 0) / (1024 * 1024);
        storageUsage.textContent = mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(1) + " MB";
    }).catch(function () { storageUsage.textContent = "Unavailable"; });
}

if (settingsBtn) settingsBtn.addEventListener("click", openSettings);
if (closeSettingsBtn) closeSettingsBtn.addEventListener("click", closeSettings);
if (doneSettingsBtn) doneSettingsBtn.addEventListener("click", closeSettings);
if (settingsModal) settingsModal.addEventListener("click", function (e) { if (e.target === settingsModal) closeSettings(); });
if (themeSelect) themeSelect.addEventListener("change", function () { updateSetting({ theme: themeSelect.value }); });

if (accentColor) accentColor.addEventListener("input", function () {
    accentHex.value = accentColor.value.toUpperCase();
    updateSetting({ accent: accentColor.value });
});

if (accentHex) accentHex.addEventListener("change", function () {
    const value = accentHex.value.trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
        const normalized = value.length === 4
            ? "#" + value.slice(1).split("").map(function (c) { return c + c; }).join("")
            : value;
        accentColor.value = normalized;
        accentHex.value = normalized.toUpperCase();
        updateSetting({ accent: normalized });
    } else {
        accentHex.value = appSettings.accent.toUpperCase();
        alert("Enter a valid HEX colour, such as #1D72FE.");
    }
});

if (playbackSpeed) playbackSpeed.addEventListener("change", function () {
    updateSetting({ speed: Number(playbackSpeed.value) });
});

if (defaultVolume) defaultVolume.addEventListener("input", function () {
    const v = Number(defaultVolume.value);
    volumeValue.textContent = v + "%";
    updateSetting({ volume: v });
});

if (resetSettingsBtn) resetSettingsBtn.addEventListener("click", function () {
    appSettings = Object.assign({}, DEFAULT_SETTINGS);
    saveAppSettings();
    applyAppSettings();
    openSettings();
});

applyAppSettings();

/* 15. INITIALIZE */
initDB().then(async function () {
    tracks = await getAllTracksMetadata();
    updateDirectorDropdown();
    renderTrackList(true);
    if (window.rishiAfterInit) window.rishiAfterInit();
}).catch(function (error) {
    console.error("Rishi Music database error:", error);
    alert("Unable to open your music library. Please do not clear browser storage.");
});

/* ============================================================
   16. PRO FEATURES (lyrics, live AI lyrics, Alexa-like Voice DJ,
       queue, playlists, folders, stats, backup, effects, crossfade)
   ============================================================ */
(function RishiProFeatures() {
    const FEATURE_KEY = "rishi_music_features_v1";
    const $ = function (id) { return document.getElementById(id); };
    const safeParse = function (v, fb) { try { return v ? JSON.parse(v) : fb; } catch (_) { return fb; } };

    const featureData = Object.assign({
        tracks: {}, queue: [], history: [], totalSeconds: 0,
        crossfade: false, effects: false, reverb: 0, width: 100,
        bass: 0, mid: 0, treble: 0, frequency: 1000,
        aiDjEnabled: true, liveAiLyrics: false
    }, safeParse(localStorage.getItem(FEATURE_KEY), {}));
    featureData.tracks = featureData.tracks || {};
    featureData.queue = featureData.queue || [];
    featureData.history = featureData.history || [];
    if (!featureData.width) featureData.width = 100;

    function saveFeatureData() {
        try { localStorage.setItem(FEATURE_KEY, JSON.stringify(featureData)); }
        catch (e) { console.warn("Feature storage is full:", e); }
    }

    function metaFor(id) {
        if (!featureData.tracks[id]) {
            featureData.tracks[id] = { lyrics: "", art: "", favorite: false, plays: 0, lastPlayed: 0, folder: "" };
        }
        return featureData.tracks[id];
    }

    function currentTrack() { return currentTrackIndex >= 0 ? tracks[currentTrackIndex] : null; }

    const style = document.createElement("style");
    style.textContent =
        "#rmx-tools{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}" +
        ".rmx-btn{border:1px solid var(--panel-border,#192033);background:var(--panel,#11141c);color:var(--text,#fff);border-radius:12px;padding:10px 12px;font-weight:650;cursor:pointer}" +
        ".rmx-btn.primary{background:var(--accent,#1d72fe);color:#fff;border-color:transparent}" +
        "#rmx-dashboard{background:var(--panel,#11141c);border:1px solid var(--panel-border,#192033);border-radius:18px;padding:14px;margin:12px 0;color:var(--text,#fff)}" +
        "#rmx-dashboard h3{margin:0 0 10px;font-size:16px}" +
        ".rmx-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}" +
        ".rmx-stat{background:rgba(127,127,127,.09);border-radius:12px;padding:11px;min-width:0}" +
        ".rmx-stat b{display:block;font-size:19px;margin-top:4px;overflow-wrap:anywhere}" +
        ".rmx-muted{color:var(--muted,#64748b);font-size:12px}" +
        ".rmx-modal{display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.78);padding:16px;align-items:center;justify-content:center}" +
        ".rmx-modal.open{display:flex}" +
        ".rmx-sheet{width:min(620px,100%);max-height:88vh;overflow:auto;background:var(--panel,#11141c);color:var(--text,#fff);border:1px solid var(--panel-border,#192033);border-radius:20px;padding:18px}" +
        ".rmx-sheet h2{font-size:20px;margin:0}" +
        ".rmx-sheet label{display:block;margin:12px 0 6px;font-size:13px;color:var(--muted,#94a3b8)}" +
        ".rmx-sheet textarea,.rmx-sheet select{width:100%;padding:11px;border-radius:10px;border:1px solid var(--panel-border,#334155);background:var(--bg,#08090d);color:var(--text,#fff)}" +
        ".rmx-sheet textarea{min-height:150px;resize:vertical}" +
        ".rmx-sheet input[type=range]{width:100%}" +
        ".rmx-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}" +
        ".rmx-cover{width:42px;height:42px;border-radius:10px;object-fit:cover;background:linear-gradient(135deg,#1d72fe,#111827);display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;flex:none}" +
        ".rmx-now-art{width:76px;height:76px;border-radius:16px;margin:0 auto 12px;display:flex}" +
        "#rmx-visualizer{width:100%;height:90px;display:block;background:rgba(0,0,0,.18);border-radius:12px;margin:10px 0}" +
        "#rmx-lyrics-line{text-align:center;min-height:32px;font-weight:700;margin:8px 0;color:var(--accent,#1d72fe)}" +
        "#rmx-lyrics-list{max-height:190px;overflow:auto;text-align:center;line-height:1.8}" +
        "#rmx-lyrics-list .active{color:var(--accent,#1d72fe);font-weight:800}" +
        "#rmx-dock-lyric{margin:6px 0;padding:7px 12px;border-radius:11px;background:rgba(29,114,254,.14);border:1px solid rgba(29,114,254,.3);color:var(--accent,#1d72fe);font-size:13px;font-weight:750;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
        ".rmx-box{margin-top:14px;padding:12px;border-radius:14px;background:rgba(127,127,127,.08);border:1px solid var(--panel-border,#192033)}" +
        ".rmx-dj-log{max-height:160px;overflow:auto;display:grid;gap:6px;margin:8px 0;padding:8px;border-radius:10px;background:var(--bg,#08090d);font-size:13px}" +
        ".rmx-dj-msg{padding:7px 10px;border-radius:10px;max-width:86%}" +
        ".rmx-dj-msg.bot{background:rgba(29,114,254,.18);color:var(--text,#fff);justify-self:start}" +
        ".rmx-dj-msg.user{background:rgba(127,127,127,.18);color:var(--text,#fff);justify-self:end}" +
        ".rmx-list{display:grid;gap:8px}" +
        ".rmx-row{display:flex;align-items:center;gap:8px;padding:9px;border-radius:11px;background:rgba(127,127,127,.08)}" +
        ".rmx-row .grow{flex:1;min-width:0}.rmx-row small{display:block;color:var(--muted,#94a3b8)}" +
        ".rmx-mini #bottomDock .progress-wrap,.rmx-mini .progress-wrap{display:none!important}" +
        ".rmx-track-actions{display:flex;gap:5px;margin-left:6px}" +
        ".rmx-track-actions button{font-size:12px;padding:6px 8px}" +
        "@media(min-width:700px){.rmx-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}";
    document.head.appendChild(style);

    const host = document.createElement("section");
    host.innerHTML =
        '<div id="rmx-dashboard"><h3>✦ RISHI MUSIC PRO DASHBOARD</h3><div class="rmx-grid">' +
        '<div class="rmx-stat"><span class="rmx-muted">Songs in library</span><b id="rmx-total">0</b></div>' +
        '<div class="rmx-stat"><span class="rmx-muted">Total plays</span><b id="rmx-plays">0</b></div>' +
        '<div class="rmx-stat"><span class="rmx-muted">Listening time</span><b id="rmx-time">0 min</b></div>' +
        '<div class="rmx-stat"><span class="rmx-muted">Favourite songs</span><b id="rmx-favs">0</b></div></div>' +
        '<p class="rmx-muted" id="rmx-topline" style="margin-top:10px">Recently played and most played songs will appear here.</p></div>' +
        '<div id="rmx-tools">' +
        '<button class="rmx-btn primary" data-open="voicedj">🎙️ AI Voice DJ</button>' +
        '<button class="rmx-btn primary" data-open="player">♫ Player & Lyrics</button>' +
        '<button class="rmx-btn" data-open="queue">Queue</button>' +
        '<button class="rmx-btn" data-open="playlists">Smart Playlists</button>' +
        '<button class="rmx-btn" data-open="folders">Folders</button>' +
        '<button class="rmx-btn" data-open="audio">Equalizer & Effects</button>' +
        '<button class="rmx-btn" data-open="backup">Backup / Restore</button>' +
        '<button class="rmx-btn" data-open="stats">Statistics</button>' +
        '<button class="rmx-btn" id="rmx-mini-toggle">Mini Player</button>' +
        '<button class="rmx-btn" data-open="theme">Theme</button></div>' +
        '<div class="rmx-modal" id="rmx-modal"><div class="rmx-sheet">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px">' +
        '<h2 id="rmx-modal-title">Rishi Music</h2><button class="rmx-btn" id="rmx-close">✕</button></div>' +
        '<div id="rmx-modal-content"></div></div></div>';
    const anchor = tracksContainer.parentElement || document.body;
    anchor.insertBefore(host, tracksContainer);

    /* Inject live lyric line inside bottom dock */
    if (dockSubtitle && !$("rmx-dock-lyric")) {
        const dockLyric = document.createElement("div");
        dockLyric.id = "rmx-dock-lyric";
        dockLyric.textContent = "♪ Synced lyrics ready";
        dockSubtitle.insertAdjacentElement("afterend", dockLyric);
    }

    /* Inject AI Voice DJ & Live AI Lyrics inside #settingsModal */
    if (settingsModal && !$("rmx-settings-ai-box")) {
        const panel = settingsModal.querySelector(".modal-content, .settings-panel, .panel") || settingsModal.firstElementChild;
        if (panel) {
            const box = document.createElement("div");
            box.id = "rmx-settings-ai-box";
            box.className = "rmx-box";
            box.innerHTML =
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">' +
                '<strong>🎙️ AI Voice DJ (Alexa-Style)</strong>' +
                '<input type="checkbox" id="rmx-set-dj-toggle" ' + (featureData.aiDjEnabled ? "checked" : "") + '>' +
                '</div>' +
                '<div class="rmx-muted" id="rmx-set-dj-status" style="margin-bottom:8px">Tap Start Voice Chat to ask for songs, moods, movies, or directors in Tamil &amp; English.</div>' +
                '<div class="rmx-actions" style="margin:0 0 12px">' +
                '<button type="button" class="rmx-btn primary" id="rmx-set-start-dj">🎙️ Start Voice Chat</button>' +
                '<button type="button" class="rmx-btn" id="rmx-set-stop-dj">Stop</button>' +
                '</div>' +
                '<div style="border-top:1px solid var(--panel-border,#192033);padding-top:10px;display:flex;align-items:center;justify-content:space-between;gap:8px">' +
                '<strong>🎤 Live AI Lyrics (Auto-Transcribe)</strong>' +
                '<input type="checkbox" id="rmx-set-live-lyrics" ' + (featureData.liveAiLyrics ? "checked" : "") + '>' +
                '</div>' +
                '<div class="rmx-muted" id="rmx-set-live-status" style="margin-top:4px">' +
                (featureData.liveAiLyrics ? "Ready — Play a song to auto-transcribe Tamil &amp; English lyrics" : "Off") +
                '</div>';
            const footer = panel.querySelector(".modal-actions, .settings-actions");
            if (footer) panel.insertBefore(box, footer);
            else panel.appendChild(box);
        }
    }

    const modal = $("rmx-modal"), modalTitle = $("rmx-modal-title"), modalContent = $("rmx-modal-content");
    function openModal(title, html) { modalTitle.textContent = title; modalContent.innerHTML = html; modal.classList.add("open"); }
    $("rmx-close").addEventListener("click", function () {
        stopVoiceDj();
        modal.classList.remove("open");
    });
    modal.addEventListener("click", function (e) {
        if (e.target === modal) {
            stopVoiceDj();
            modal.classList.remove("open");
        }
    });

    function coverMarkup(track, extra) {
        const m = track ? metaFor(track.id) : null;
        return m && m.art
            ? '<img class="rmx-cover ' + (extra || "") + '" src="' + m.art + '" alt="Album cover">'
            : '<span class="rmx-cover ' + (extra || "") + '">♫</span>';
    }

    function updateDashboard() {
        const metas = tracks.map(function (t) { return metaFor(t.id); });
        $("rmx-total").textContent = tracks.length;
        $("rmx-plays").textContent = metas.reduce(function (n, m) { return n + (m.plays || 0); }, 0);
        $("rmx-favs").textContent = metas.filter(function (m) { return m.favorite; }).length;
        const mins = Math.floor((featureData.totalSeconds || 0) / 60);
        $("rmx-time").textContent = mins < 60 ? mins + " min" : Math.floor(mins / 60) + "h " + (mins % 60) + "m";
        const recent = tracks.filter(function (t) { return metaFor(t.id).lastPlayed; })
            .sort(function (a, b) { return metaFor(b.id).lastPlayed - metaFor(a.id).lastPlayed; })[0];
        const top = tracks.slice().sort(function (a, b) { return metaFor(b.id).plays - metaFor(a.id).plays; })[0];
        $("rmx-topline").textContent = (recent ? "Recently played: " + recent.title : "No recent plays yet.") +
            (top && metaFor(top.id).plays ? "  •  Most played: " + top.title : "");
    }

    /* ============================================================
       A. ALEXA-LIKE AI VOICE DJ (TAMIL & ENGLISH + FUZZY MATCH)
       ============================================================ */
    let djRec = null;
    let djConversationActive = false;

    function normalizeKey(s) {
        return String(s || "")
            .toLowerCase()
            .replace(/[\s\-_]+/g, "")
            .replace(/[^\p{L}\p{N}]/gu, "");
    }

    const MOOD_KEYWORDS = {
        love: ["love", "romantic", "kadhal", "காதல்", "melody", "மெலடி", "heart"],
        mass: ["mass", "kuthu", "dance", "beat", "fast", "குத்து", "ஆட்டம்", "vijay", "youth"],
        sad: ["sad", "soup", "breakup", "pain", "sogam", "சோகம்", "வலி", "alone"],
        chill: ["chill", "relax", "sleep", "night", "calm", "இரவு", "அமைதி"]
    };

    function appendDjChat(role, text) {
        const log = $("rmx-dj-log");
        if (!log) return;
        const div = document.createElement("div");
        div.className = "rmx-dj-msg " + role;
        div.textContent = text;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
    }

    function setDjStatus(text) {
        if ($("rmx-set-dj-status")) $("rmx-set-dj-status").textContent = text;
        if ($("rmx-modal-dj-status")) $("rmx-modal-dj-status").textContent = text;
    }

    function speakDj(text, onDone) {
        appendDjChat("bot", "🤖 " + text);
        setDjStatus(text);
        if (!("speechSynthesis" in window)) {
            if (onDone) onDone();
            return;
        }
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = /[\u0B80-\u0BFF]/.test(text) ? "ta-IN" : "en-US";
        u.rate = 1.02;
        u.onend = function () { if (onDone) onDone(); };
        u.onerror = function () { if (onDone) onDone(); };
        window.speechSynthesis.speak(u);
    }

    function matchTracksByVoice(spoken) {
        const cleanSpoken = normalizeKey(spoken);
        const words = spoken.toLowerCase().split(/[\s\-_]+/).filter(function (w) { return w.length > 1; });

        let matches = tracks.map(function (t, i) { return i; }).filter(function (i) {
            const tTitle = normalizeKey(tracks[i].title);
            const tDir = normalizeKey(tracks[i].director);
            return (cleanSpoken && (tTitle.includes(cleanSpoken) || cleanSpoken.includes(tTitle) || tDir.includes(cleanSpoken))) ||
                   words.some(function (w) {
                       const nw = normalizeKey(w);
                       return nw.length > 2 && (tTitle.includes(nw) || tDir.includes(nw));
                   });
        });

        if (!matches.length) {
            Object.values(MOOD_KEYWORDS).forEach(function (keys) {
                if (!matches.length && keys.some(function (k) { return spoken.toLowerCase().includes(k); })) {
                    matches = tracks.map(function (t, i) { return i; }).filter(function (i) {
                        const combo = (tracks[i].title + " " + tracks[i].director).toLowerCase();
                        return keys.some(function (k) { return combo.includes(k); });
                    });
                }
            });
        }
        return matches;
    }

    function stopVoiceDj() {
        djConversationActive = false;
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        if (djRec) {
            try { djRec.stop(); } catch (_) {}
            djRec = null;
        }
        setDjStatus("Voice DJ stopped.");
    }

    function startVoiceDjSession() {
        featureData.aiDjEnabled = true;
        saveFeatureData();
        if ($("rmx-set-dj-toggle")) $("rmx-set-dj-toggle").checked = true;

        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            alert("Voice DJ is not supported in this browser. Please use Google Chrome.");
            return;
        }
        if (!tracks.length) {
            speakDj("Your library is empty. Please import some songs first.");
            return;
        }

        djConversationActive = true;
        if (!audio.paused) pauseCurrentTrack();

        function listenTurn() {
            if (!djConversationActive) return;
            if (djRec) { try { djRec.stop(); } catch (_) {} }

            djRec = new SR();
            djRec.lang = "ta-IN"; // Understands both Tamil & English
            djRec.interimResults = false;
            djRec.maxAlternatives = 3;

            djRec.onstart = function () {
                setDjStatus("🎙️ Listening (say a song, movie, director, mood, or 'stop')...");
            };

            djRec.onresult = async function (e) {
                let allAlts = "";
                for (let i = 0; i < e.results[0].length; i++) {
                    allAlts += " " + e.results[0][i].transcript;
                }
                const primary = e.results[0][0].transcript.trim();
                appendDjChat("user", "🗣️ " + primary);

                const cmd = primary.toLowerCase();
                if (cmd === "stop" || cmd === "cancel" || cmd === "exit" || cmd === "நிறுத்து") {
                    djConversationActive = false;
                    speakDj("Okay, closing Voice DJ.");
                    return;
                }
                if (cmd.includes("next") || cmd.includes("skip") || cmd.includes("அடுத்த")) {
                    djConversationActive = false;
                    speakDj("Playing next song.", function () { advanceToNextTrack(); });
                    return;
                }
                if (cmd.includes("pause") || cmd.includes("stop music")) {
                    djConversationActive = false;
                    pauseCurrentTrack();
                    speakDj("Music paused.");
                    return;
                }

                const matches = matchTracksByVoice(allAlts);
                if (matches.length) {
                    const pick = matches[Math.floor(Math.random() * matches.length)];
                    const song = tracks[pick];
                    djConversationActive = false;
                    speakDj("Playing " + song.title, async function () {
                        if (await loadTrackSource(pick)) {
                            await playCurrentTrack();
                            if (settingsModal) settingsModal.classList.remove("open");
                            modal.classList.remove("open");
                        }
                    });
                } else {
                    speakDj("I couldn't find " + primary + ". Try another song, director, or mood?", function () {
                        listenTurn(); // Alexa-style follow-up listening turn
                    });
                }
            };

            djRec.onerror = function (err) {
                if (err.error === "no-speech" && djConversationActive) {
                    speakDj("I didn't hear anything. What would you like to listen to?", function () {
                        listenTurn();
                    });
                } else {
                    djConversationActive = false;
                    setDjStatus("Voice DJ error: " + err.error);
                }
            };

            djRec.onend = function () { djRec = null; };
            try { djRec.start(); } catch (_) {}
        }

        speakDj("What would you like to listen to?", function () {
            listenTurn();
        });
    }

    function showVoiceDjModal() {
        openModal("🎙️ AI Voice DJ",
            '<p class="rmx-muted">Ask in <b>Tamil or English</b> for any song title, movie name, music director, or mood (love, mass, sad, chill).</p>' +
            '<div id="rmx-modal-dj-status" style="font-weight:700;color:var(--accent,#1d72fe);margin:8px 0">Ready — Tap Start Voice Chat</div>' +
            '<div class="rmx-dj-log" id="rmx-dj-log"></div>' +
            '<div class="rmx-actions">' +
            '<button class="rmx-btn primary" id="rmx-modal-start-dj">🎙️ Start Voice Chat</button>' +
            '<button class="rmx-btn" id="rmx-modal-stop-dj">Stop</button></div>');
        $("rmx-modal-start-dj").onclick = startVoiceDjSession;
        $("rmx-modal-stop-dj").onclick = stopVoiceDj;
        startVoiceDjSession();
    }

    if ($("rmx-set-dj-toggle")) {
        $("rmx-set-dj-toggle").onchange = function (e) {
            featureData.aiDjEnabled = e.target.checked;
            saveFeatureData();
            if (!featureData.aiDjEnabled) stopVoiceDj();
        };
    }
    if ($("rmx-set-start-dj")) $("rmx-set-start-dj").onclick = startVoiceDjSession;
    if ($("rmx-set-stop-dj")) $("rmx-set-stop-dj").onclick = stopVoiceDj;

    /* ============================================================
       B. AUTOMATIC LIVE AI LYRICS (CONTINUOUS REAL-TIME TRANSCRIBER)
       ============================================================ */
    let liveLyricRec = null;

    function updateLiveLyricsStatus(msg) {
        if ($("rmx-set-live-status")) $("rmx-set-live-status").textContent = msg;
    }

    function startLiveAiLyrics() {
        if (!featureData.liveAiLyrics) return;
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            updateLiveLyricsStatus("Live AI Lyrics not supported in this browser.");
            return;
        }
        if (liveLyricRec) return;

        liveLyricRec = new SR();
        liveLyricRec.lang = "ta-IN"; // Recognises Tamil & English singing
        liveLyricRec.continuous = true;
        liveLyricRec.interimResults = true;

        liveLyricRec.onstart = function () {
            updateLiveLyricsStatus("🎤 Listening to song & auto-saving lyrics...");
        };

        liveLyricRec.onresult = function (e) {
            const t = currentTrack();
            if (!t || audio.paused) return;

            let interim = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const res = e.results[i];
                const text = res[0].transcript.trim();
                if (!text) continue;

                if (res.isFinal) {
                    const sec = audio.currentTime || 0;
                    const m = String(Math.floor(sec / 60)).padStart(2, "0");
                    const s = (sec % 60).toFixed(2).padStart(5, "0");
                    const stampedLine = "[" + m + ":" + s + "]" + text;

                    const mObj = metaFor(t.id);
                    const existing = (mObj.lyrics || "").trim();
                    mObj.lyrics = existing ? existing + "\n" + stampedLine : stampedLine;
                    saveFeatureData();

                    if ($("rmx-lyrics-input")) $("rmx-lyrics-input").value = mObj.lyrics;
                    renderLyrics(t);
                    syncDockLyric(t);
                } else {
                    interim = text;
                }
            }

            if (interim) {
                if ($("rmx-dock-lyric")) $("rmx-dock-lyric").textContent = "🎤 " + interim;
                if ($("rmx-lyrics-line")) $("rmx-lyrics-line").textContent = interim;
            }
        };

        liveLyricRec.onerror = function () {};

        liveLyricRec.onend = function () {
            liveLyricRec = null;
            if (featureData.liveAiLyrics && !audio.paused) {
                setTimeout(startLiveAiLyrics, 300);
            } else {
                updateLiveLyricsStatus(featureData.liveAiLyrics ? "Paused (waiting for playback)" : "Off");
            }
        };

        try { liveLyricRec.start(); } catch (_) { liveLyricRec = null; }
    }

    function stopLiveAiLyrics() {
        if (liveLyricRec) {
            try { liveLyricRec.stop(); } catch (_) {}
            liveLyricRec = null;
        }
        updateLiveLyricsStatus(featureData.liveAiLyrics ? "Paused (waiting for playback)" : "Off");
    }

    if ($("rmx-set-live-lyrics")) {
        $("rmx-set-live-lyrics").onchange = function (e) {
            featureData.liveAiLyrics = e.target.checked;
            saveFeatureData();
            if (featureData.liveAiLyrics) {
                if (!audio.paused) startLiveAiLyrics();
                else updateLiveLyricsStatus("Ready — Play a song to auto-transcribe Tamil & English lyrics");
            } else {
                stopLiveAiLyrics();
            }
        };
    }

    /* Lyrics Parser & Sync Renderer */
    function parseLyricLines(raw) {
        return (raw || "").split(/\r?\n/).map(function (line) {
            const m = line.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
            return m ? { time: Number(m[1]) * 60 + Number(m[2]) + Number("0." + (m[3] || "0")), text: m[4] } : { time: null, text: line };
        }).filter(function (x) { return x.text.trim(); });
    }

    function syncDockLyric(track) {
        const dockEl = $("rmx-dock-lyric");
        if (!dockEl) return;
        if (!track) {
            dockEl.textContent = "♪ Synced lyrics ready";
            return;
        }
        const lines = parseLyricLines(metaFor(track.id).lyrics);
        if (!lines.length) {
            dockEl.textContent = "♪ " + track.title + " — " + track.director;
            return;
        }
        const timed = lines.filter(function (x) { return x.time !== null; });
        const active = timed.filter(function (x) { return x.time <= (audio.currentTime || 0); }).pop();
        const text = (active && active.text) || lines[0].text;
        dockEl.textContent = "♪ " + text;
    }

    function renderLyrics(track) {
        if (!track || !$("rmx-lyrics-line")) return;
        const lines = parseLyricLines(metaFor(track.id).lyrics);
        const timed = lines.filter(function (x) { return x.time !== null; });
        const active = timed.filter(function (x) { return x.time <= (audio.currentTime || 0); }).pop();
        $("rmx-lyrics-line").textContent = (active && active.text) ||
            (lines.length && !timed.length ? lines[0].text : "Add lyrics or enable Live AI Lyrics in Settings");
        $("rmx-lyrics-list").innerHTML = lines.map(function (x) {
            return '<div class="' + (x === active ? "active" : "") + '">' + esc(x.text) + "</div>";
        }).join("");
    }

    function resizeImage(file) {
        return new Promise(function (resolve) {
            if (!file.type.startsWith("image/")) return resolve(null);
            const img = new Image(), url = URL.createObjectURL(file);
            img.onload = function () {
                const c = document.createElement("canvas");
                const s = Math.min(1, 420 / Math.max(img.width, img.height));
                c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
                c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
                URL.revokeObjectURL(url);
                resolve(c.toDataURL("image/jpeg", 0.78));
            };
            img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
            img.src = url;
        });
    }

    function showPlayer() {
        const t = currentTrack(), m = t ? metaFor(t.id) : null;
        openModal("Player • Lyrics • Album Art",
            coverMarkup(t, "rmx-now-art") +
            '<div style="text-align:center;font-weight:800">' + esc(t ? t.title : "No song selected") + "</div>" +
            '<div class="rmx-muted" style="text-align:center">' + esc(t ? t.director : "Choose a song from your library") + "</div>" +
            '<canvas id="rmx-visualizer"></canvas>' +
            '<div id="rmx-lyrics-line"></div><div id="rmx-lyrics-list"></div>' +
            "<label>Lyrics (Tamil &amp; English — plain text or LRC timestamps like [00:12.50])</label>" +
            '<textarea id="rmx-lyrics-input" placeholder="[00:05.00]First lyric line">' + esc(m ? m.lyrics : "") + "</textarea>" +
            '<label>Album cover for this song</label><input id="rmx-art-input" type="file" accept="image/*">' +
            '<div class="rmx-actions"><button class="rmx-btn primary" id="rmx-save-lyrics">Save lyrics</button>' +
            '<button class="rmx-btn" id="rmx-favorite">' + (m && m.favorite ? "★ Remove favourite" : "☆ Add favourite") + "</button>" +
            '<button class="rmx-btn" id="rmx-add-queue">Add to queue</button></div>');
        renderLyrics(t);
        $("rmx-save-lyrics").onclick = function () {
            if (!t) return;
            metaFor(t.id).lyrics = $("rmx-lyrics-input").value;
            saveFeatureData(); renderLyrics(t); syncDockLyric(t); alert("Lyrics saved for this song.");
        };
        $("rmx-favorite").onclick = function () {
            if (!t) return;
            metaFor(t.id).favorite = !metaFor(t.id).favorite;
            saveFeatureData(); showPlayer(); updateDashboard();
        };
        $("rmx-add-queue").onclick = function () { if (t) addToQueue(t.id); };
        $("rmx-art-input").onchange = async function (e) {
            if (!t || !e.target.files[0]) return;
            const data = await resizeImage(e.target.files[0]);
            if (!data) return alert("Could not read this image.");
            metaFor(t.id).art = data; saveFeatureData(); showPlayer(); enhanceTrackCards(true);
        };
        startVisualizer();
    }

    /* Web Audio (opt-in so background playback stays reliable) */
    let audioCtx = null, mediaSource = null, analyser = null, bassF, midF, trebF, reverbNode, dryGain, wetGain;
    let splitter, merger, ll, lr, rl, rr, visualFrame = 0;

    function setupAudioGraph() {
        if (audioCtx) return true;
        if (!featureData.effects) return false;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try {
            audioCtx = new AC();
            mediaSource = audioCtx.createMediaElementSource(audio);
            bassF = audioCtx.createBiquadFilter(); bassF.type = "lowshelf"; bassF.frequency.value = 180;
            midF = audioCtx.createBiquadFilter(); midF.type = "peaking"; midF.Q.value = 1;
            trebF = audioCtx.createBiquadFilter(); trebF.type = "highshelf"; trebF.frequency.value = 4500;
            analyser = audioCtx.createAnalyser(); analyser.fftSize = 128;
            splitter = audioCtx.createChannelSplitter(2); merger = audioCtx.createChannelMerger(2);
            ll = audioCtx.createGain(); lr = audioCtx.createGain(); rl = audioCtx.createGain(); rr = audioCtx.createGain();
            dryGain = audioCtx.createGain(); wetGain = audioCtx.createGain();
            reverbNode = audioCtx.createConvolver();
            const len = Math.floor(audioCtx.sampleRate * 1.6);
            const impulse = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
            for (let ch = 0; ch < 2; ch++) {
                const d = impulse.getChannelData(ch);
                for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
            }
            reverbNode.buffer = impulse;
            mediaSource.connect(bassF); bassF.connect(midF); midF.connect(trebF); trebF.connect(splitter);
            splitter.connect(ll, 0); ll.connect(merger, 0, 0);
            splitter.connect(lr, 1); lr.connect(merger, 0, 0);
            splitter.connect(rl, 0); rl.connect(merger, 0, 1);
            splitter.connect(rr, 1); rr.connect(merger, 0, 1);
            merger.connect(analyser); analyser.connect(dryGain); dryGain.connect(audioCtx.destination);
            merger.connect(reverbNode); reverbNode.connect(wetGain); wetGain.connect(audioCtx.destination);
            applyAudioSettings();
            return true;
        } catch (e) {
            console.warn("Audio effects not supported:", e);
            audioCtx = null; return false;
        }
    }

    function applyAudioSettings() {
        if (!audioCtx) return;
        bassF.gain.value = Number(featureData.bass || 0);
        midF.gain.value = Number(featureData.mid || 0);
        midF.frequency.value = Number(featureData.frequency || 1000);
        trebF.gain.value = Number(featureData.treble || 0);
        wetGain.gain.value = Number(featureData.reverb || 0) / 100 * 0.45;
        dryGain.gain.value = 1;
        const w = Math.max(0, Math.min(200, Number(featureData.width == null ? 100 : featureData.width))) / 100;
        ll.gain.value = rr.gain.value = (1 + w) / 2;
        lr.gain.value = rl.gain.value = (1 - w) / 2;
    }

    function startVisualizer() {
        const canvas = $("rmx-visualizer");
        if (!canvas) return;
        if (!setupAudioGraph()) {
            canvas.style.display = "none";
            return;
        }
        audioCtx.resume().catch(function () {});
        const ctx = canvas.getContext("2d");
        function draw() {
            if (!canvas.isConnected) { cancelAnimationFrame(visualFrame); return; }
            const w = canvas.clientWidth || 300, h = canvas.clientHeight || 90, dpr = window.devicePixelRatio || 1;
            if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const data = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(data);
            ctx.clearRect(0, 0, w, h);
            const gap = 3, bw = Math.max(2, (w - gap * (data.length - 1)) / data.length);
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1d72fe";
            for (let i = 0; i < data.length; i++) {
                const bh = Math.max(2, (data[i] / 255) * h);
                ctx.fillRect(i * (bw + gap), h - bh, bw, bh);
            }
            visualFrame = requestAnimationFrame(draw);
        }
        cancelAnimationFrame(visualFrame); draw();
    }

    function showAudioSettings() {
        const fd = featureData;
        function slider(id, label, min, max, val, suf, step) {
            return '<label>' + label + ' <span id="' + id + '-v">' + val + suf + '</span></label><input id="' + id + '" type="range" min="' + min + '" max="' + max + '" step="' + (step || 1) + '" value="' + val + '">';
        }
        openModal("Equalizer & Audio Effects",
            '<label style="display:flex;gap:8px;align-items:center;color:inherit"><input id="rmx-effects" type="checkbox" ' + (fd.effects ? "checked" : "") + '> Turn effects ON (equalizer, reverb, width, visualizer)</label>' +
            '<p class="rmx-muted">Off by default: effects can stop background/lock-screen playback on some phones. Test after enabling. Turning off needs a page reload.</p>' +
            slider("rmx-bass", "Bass", -12, 12, fd.bass, " dB") + slider("rmx-mid", "Mid", -12, 12, fd.mid, " dB") +
            slider("rmx-treble", "Treble", -12, 12, fd.treble, " dB") + slider("rmx-freq", "Mid frequency", 250, 8000, fd.frequency, " Hz", 50) +
            slider("rmx-reverb", "Reverb", 0, 100, fd.reverb, "%") + slider("rmx-width", "Stereo width", 0, 200, fd.width, "%") +
            '<label style="display:flex;gap:8px;align-items:center;color:inherit"><input id="rmx-crossfade" type="checkbox" ' + (fd.crossfade ? "checked" : "") + '> 5-second fade-out transition between songs</label>' +
            '<div class="rmx-actions"><button class="rmx-btn" id="rmx-eq-reset">Reset equalizer</button></div>');
        $("rmx-effects").onchange = function (e) {
            fd.effects = e.target.checked; saveFeatureData();
            if (fd.effects) { if (!setupAudioGraph()) { alert("Effects aren't supported in this browser."); fd.effects = false; saveFeatureData(); e.target.checked = false; } else audioCtx.resume().catch(function () {}); }
            else alert("Reload the page to fully switch effects off.");
        };
        [["rmx-bass", "bass", " dB"], ["rmx-mid", "mid", " dB"], ["rmx-treble", "treble", " dB"], ["rmx-freq", "frequency", " Hz"], ["rmx-reverb", "reverb", "%"], ["rmx-width", "width", "%"]].forEach(function (a) {
            $(a[0]).oninput = function (e) {
                fd[a[1]] = Number(e.target.value);
                $(a[0] + "-v").textContent = fd[a[1]] + a[2];
                saveFeatureData(); applyAudioSettings();
            };
        });
        $("rmx-crossfade").onchange = function (e) { fd.crossfade = e.target.checked; saveFeatureData(); };
        $("rmx-eq-reset").onclick = function () {
            Object.assign(fd, { bass: 0, mid: 0, treble: 0, reverb: 0, frequency: 1000, width: 100 });
            saveFeatureData(); applyAudioSettings(); showAudioSettings();
        };
    }

    /* Queue (has priority over daily random pick) */
    function addToQueue(id) {
        if (!tracks.some(function (t) { return t.id === id; })) return;
        if (featureData.queue.indexOf(id) < 0) featureData.queue.push(id);
        saveFeatureData(); alert("Added to upcoming queue.");
    }

    function showQueue() {
        const items = featureData.queue.map(function (id, i) {
            const t = tracks.find(function (x) { return x.id === id; });
            return t ? { id: id, t: t, i: i } : null;
        }).filter(Boolean);
        openModal("Upcoming Queue",
            '<div class="rmx-list">' + (items.length ? items.map(function (x) {
                return '<div class="rmx-row"><div class="grow"><b>' + esc(x.t.title) + "</b><small>" + esc(x.t.director) + "</small></div>" +
                    '<button class="rmx-btn" data-q-up="' + x.i + '">↑</button><button class="rmx-btn" data-q-down="' + x.i + '">↓</button><button class="rmx-btn" data-q-remove="' + esc(x.id) + '">✕</button></div>';
            }).join("") : "<p class='rmx-muted'>Your queue is empty. Add tracks from the library.</p>") + "</div>" +
            '<div class="rmx-actions"><button class="rmx-btn" id="rmx-clear-queue">Clear queue</button></div>');
        function swap(i, j) {
            const q = featureData.queue;
            if (j < 0 || j >= q.length) return;
            const tmp = q[i]; q[i] = q[j]; q[j] = tmp;
            saveFeatureData(); showQueue();
        }
        modalContent.querySelectorAll("[data-q-remove]").forEach(function (b) {
            b.onclick = function () { featureData.queue = featureData.queue.filter(function (id) { return id !== b.dataset.qRemove; }); saveFeatureData(); showQueue(); };
        });
        modalContent.querySelectorAll("[data-q-up]").forEach(function (b) { b.onclick = function () { swap(+b.dataset.qUp, +b.dataset.qUp - 1); }; });
        modalContent.querySelectorAll("[data-q-down]").forEach(function (b) { b.onclick = function () { swap(+b.dataset.qDown, +b.dataset.qDown + 1); }; });
        $("rmx-clear-queue").onclick = function () { featureData.queue = []; saveFeatureData(); showQueue(); };
    }

    const originalNextIndex = getNextUnplayedIndex;
    getNextUnplayedIndex = function () {
        while (featureData.queue.length) {
            const id = featureData.queue.shift();
            const idx = tracks.findIndex(function (t) { return t.id === id; });
            if (idx >= 0 && idx !== currentTrackIndex) { saveFeatureData(); return idx; }
        }
        return originalNextIndex();
    };

    /* Smart playlists */
    function showPlaylists() {
        const sortBy = function (arr, fn) { return arr.slice().sort(fn); };
        const fav = tracks.filter(function (t) { return metaFor(t.id).favorite; });
        const most = sortBy(tracks.filter(function (t) { return metaFor(t.id).plays; }), function (a, b) { return metaFor(b.id).plays - metaFor(a.id).plays; });
        const recent = sortBy(tracks.filter(function (t) { return metaFor(t.id).lastPlayed; }), function (a, b) { return metaFor(b.id).lastPlayed - metaFor(a.id).lastPlayed; });
        const fresh = tracks.filter(function (t) { return !metaFor(t.id).plays; });
        const block = function (title, list) {
            return '<h3 style="margin:14px 0 7px;font-size:15px">' + title + " (" + list.length + ')</h3><div class="rmx-list">' +
                (list.slice(0, 30).map(function (t) {
                    return '<div class="rmx-row">' + coverMarkup(t) + '<div class="grow"><b>' + esc(t.title) + "</b><small>" + esc(t.director) + '</small></div><button class="rmx-btn" data-play-id="' + esc(t.id) + '">▶</button></div>';
                }).join("") || "<p class='rmx-muted'>No songs yet.</p>") + "</div>";
        };
        openModal("Smart Playlists", block("★ Favourites", fav) + block("Most played", most) + block("Recently played", recent) + block("Not yet played", fresh));
        modalContent.querySelectorAll("[data-play-id]").forEach(function (b) {
            b.onclick = async function () {
                const i = tracks.findIndex(function (t) { return t.id === b.dataset.playId; });
                if (i >= 0) { await loadTrackSource(i); await playCurrentTrack(); modal.classList.remove("open"); }
            };
        });
    }

    /* Folder import */
    function showFolders() {
        openModal("Folder Browser",
            '<p class="rmx-muted">Choose a folder to import its audio files. Support depends on your browser.</p>' +
            '<input id="rmx-folder-input" type="file" webkitdirectory directory multiple accept="audio/*">' +
            '<div id="rmx-folder-list" class="rmx-list" style="margin-top:14px"></div>');
        $("rmx-folder-input").onchange = async function (e) {
            const files = Array.from(e.target.files).filter(function (f) { return f.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(f.name); });
            if (!files.length) return alert("No supported audio files found in this folder.");
            if (!confirm("Import " + files.length + " audio files into your existing library?")) return;
            const batch = files.map(function (f) {
                const id = "track_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
                metaFor(id).folder = (f.webkitRelativePath || "").split("/").slice(0, -1).join("/") || "Selected folder";
                return { id: id, title: f.name.replace(/\.[^.]+$/, ""), director: "UNKNOWN DIRECTOR", blob: f };
            });
            try {
                await saveTracksBatch(batch);
                batch.forEach(function (b) { tracks.push({ id: b.id, title: b.title, director: b.director }); });
                saveFeatureData(); updateDirectorDropdown(); renderTrackList(true); updateDashboard();
                alert("Imported " + batch.length + " tracks.");
            } catch (err) { alert("Folder import failed: " + (err && err.message || err)); }
        };
        const dirs = Array.from(new Set(tracks.map(function (t) { return metaFor(t.id).folder; }).filter(Boolean)));
        $("rmx-folder-list").innerHTML = dirs.length
            ? dirs.map(function (d) { return '<div class="rmx-row">' + esc(d) + "</div>"; }).join("")
            : "<p class='rmx-muted'>Folders appear here for songs imported with this picker.</p>";
    }

    /* Stats */
    function showStats() {
        const total = tracks.reduce(function (n, t) { return n + metaFor(t.id).plays; }, 0);
        const dirs = {};
        tracks.forEach(function (t) { dirs[t.director] = (dirs[t.director] || 0) + metaFor(t.id).plays; });
        const topDirs = Object.entries(dirs).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);
        const topSongs = tracks.slice().sort(function (a, b) { return metaFor(b.id).plays - metaFor(a.id).plays; }).slice(0, 10);
        const s = featureData.totalSeconds;
        openModal("Listening Statistics",
            '<div class="rmx-grid"><div class="rmx-stat">Songs<b>' + tracks.length + "</b></div><div class=\"rmx-stat\">Plays<b>" + total + "</b></div>" +
            '<div class="rmx-stat">Listening time<b>' + Math.floor(s / 3600) + "h " + Math.floor(s % 3600 / 60) + "m</b></div>" +
            '<div class="rmx-stat">Favourites<b>' + tracks.filter(function (t) { return metaFor(t.id).favorite; }).length + "</b></div></div>" +
            '<h3 style="margin:16px 0 8px;font-size:15px">Top songs</h3>' + topSongs.map(function (t) { return '<div class="rmx-row"><div class="grow">' + esc(t.title) + "<small>" + metaFor(t.id).plays + " plays</small></div></div>"; }).join("") +
            '<h3 style="margin:16px 0 8px;font-size:15px">Top directors by plays</h3>' + topDirs.map(function (d) { return '<div class="rmx-row"><div class="grow">' + esc(d[0]) + "</div><b>" + d[1] + "</b></div>"; }).join(""));
    }

    /* Backup / restore */
    function blobToDataURL(blob) {
        return new Promise(function (res, rej) { const r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; r.readAsDataURL(blob); });
    }
    function dataURLToBlob(u) {
        const parts = u.split(","), mime = (parts[0].match(/:(.*?);/) || [])[1] || "audio/mpeg";
        const bin = atob(parts[1]), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    function showBackup() {
        openModal("Backup & Restore",
            '<p class="rmx-muted">The information backup saves titles, directors, lyrics, artwork, statistics and settings. The full backup also includes every audio file and may be too large for a phone with a big library.</p>' +
            '<div class="rmx-actions"><button class="rmx-btn primary" id="rmx-export-meta">Export information backup</button>' +
            '<button class="rmx-btn" id="rmx-export-full">Export FULL backup (with audio)</button></div>' +
            '<label>Restore a Rishi Music JSON backup</label><input id="rmx-restore-file" type="file" accept="application/json,.json">' +
            '<p class="rmx-muted">Restore only adds missing tracks; it never clears your library.</p>');
        function download(data, name) {
            const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
            const a = document.createElement("a"); a.href = url; a.download = name; a.click();
            setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
        }
        async function snapshot(includeAudio) {
            const payload = { format: "RishiMusicBackup", version: 1, createdAt: new Date().toISOString(),
                settings: safeParse(localStorage.getItem(SETTINGS_KEY), {}), daily: safeParse(localStorage.getItem("rishi_daily_plays_v4"), {}),
                features: featureData, tracks: [] };
            const rows = [];
            await new Promise(function (resolve, reject) {
                const req = db.transaction([STORE_NAME], "readonly").objectStore(STORE_NAME).openCursor();
                req.onsuccess = function (e) { const c = e.target.result; if (!c) return resolve(); rows.push(c.value); c.continue(); };
                req.onerror = function () { reject(req.error); };
            });
            for (const r of rows) {
                const item = { id: r.id, title: r.title, director: r.director };
                if (includeAudio && r.blob) item.audio = await blobToDataURL(r.blob);
                payload.tracks.push(item);
            }
            return payload;
        }
        $("rmx-export-meta").onclick = async function () { try { download(await snapshot(false), "rishi-music-information-backup.json"); } catch (e) { alert("Backup failed: " + e.message); } };
        $("rmx-export-full").onclick = async function () {
            if (!confirm("A full backup needs lots of memory and storage. Continue?")) return;
            try { download(await snapshot(true), "rishi-music-full-backup.json"); } catch (e) { alert("Full backup failed. Try the information backup. " + e.message); }
        };
        $("rmx-restore-file").onchange = async function (e) {
            const file = e.target.files[0]; if (!file) return;
            if (!confirm("Restore this backup? Existing tracks are kept; only missing ones are added.")) return;
            try {
                const b = JSON.parse(await file.text());
                if (b.format !== "RishiMusicBackup" || !Array.isArray(b.tracks)) throw new Error("This is not a valid Rishi Music backup.");
                const have = new Set(tracks.map(function (t) { return t.id; })), batch = [];
                b.tracks.forEach(function (r) {
                    if (r.id && !have.has(r.id) && r.audio) batch.push({ id: r.id, title: r.title || "Unknown", director: r.director || "UNKNOWN DIRECTOR", blob: dataURLToBlob(r.audio) });
                });
                if (batch.length) await saveTracksBatch(batch);
                batch.forEach(function (x) { tracks.push({ id: x.id, title: x.title, director: x.director }); });
                if (b.features && typeof b.features === "object") { Object.assign(featureData, b.features); saveFeatureData(); }
                if (b.settings) { appSettings = Object.assign({}, appSettings, b.settings); saveAppSettings(); applyAppSettings(); }
                updateDirectorDropdown(); renderTrackList(true); updateDashboard();
                alert("Restore finished. Added " + batch.length + " songs with audio. Entries without audio can't be restored as playable tracks.");
            } catch (err) { alert("Restore failed: " + err.message); }
        };
    }

    /* Card enhancements: favourite, queue, cover */
    function enhanceTrackCards(force) {
        tracksContainer.querySelectorAll(".track-card").forEach(function (card) {
            if (card.dataset.rmx && !force) return;
            const play = card.querySelector('[data-action="play"]');
            const t = tracks[Number(play && play.dataset.idx)];
            if (!t) return;
            const main = card.querySelector(".track-main");
            if (main) {
                const old = main.querySelector(".rmx-cover"); if (old) old.remove();
                main.insertAdjacentHTML("afterbegin", coverMarkup(t));
            }
            if (card.dataset.rmx) return;
            card.dataset.rmx = "1";
            const area = document.createElement("div"); area.className = "rmx-track-actions";
            const fav = document.createElement("button"); fav.className = "rmx-btn"; fav.textContent = metaFor(t.id).favorite ? "★" : "☆";
            fav.onclick = function () { metaFor(t.id).favorite = !metaFor(t.id).favorite; saveFeatureData(); fav.textContent = metaFor(t.id).favorite ? "★" : "☆"; updateDashboard(); };
            const q = document.createElement("button"); q.className = "rmx-btn"; q.textContent = "+ Queue"; q.onclick = function () { addToQueue(t.id); };
            area.append(fav, q);
            const acts = card.querySelector(".track-actions"); if (acts) acts.append(area);
        });
    }
    new MutationObserver(function () { enhanceTrackCards(); }).observe(tracksContainer, { childList: true });
    window.rishiAfterInit = function () { enhanceTrackCards(); updateDashboard(); syncDockLyric(currentTrack()); };

    /* Play counts + listening time + Live AI Lyrics triggers */
    let countedTrackId = null, lastTick = 0, fadeInPending = false;
    audio.addEventListener("playing", function () {
        if (fadeInPending) {
            fadeInPending = false;
            const target = Math.max(0, Math.min(1, Number(appSettings.volume) / 100)), start = Date.now();
            const iv = setInterval(function () {
                const p = Math.min(1, (Date.now() - start) / 1200);
                audio.volume = target * p;
                if (p >= 1) clearInterval(iv);
            }, 50);
        }
        if (featureData.liveAiLyrics) startLiveAiLyrics();
        const t = currentTrack(); if (!t) return;
        if (countedTrackId !== t.id) {
            const m = metaFor(t.id); m.plays = (m.plays || 0) + 1; m.lastPlayed = Date.now();
            countedTrackId = t.id;
            featureData.history.unshift({ id: t.id, at: Date.now() });
            featureData.history = featureData.history.slice(0, 200);
            saveFeatureData(); updateDashboard();
        }
        lastTick = Date.now();
        if (audioCtx) audioCtx.resume().catch(function () {});
    });
    audio.addEventListener("pause", function () {
        lastTick = 0;
        stopLiveAiLyrics();
    });
    audio.addEventListener("ended", function () {
        countedTrackId = null;
        stopLiveAiLyrics();
    });

    audio.addEventListener("timeupdate", function () {
        if (audio.paused) return;
        if (lastTick && Date.now() - lastTick >= 9000) {
            featureData.totalSeconds += Math.round((Date.now() - lastTick) / 1000);
            lastTick = Date.now(); saveFeatureData(); updateDashboard();
        }
        const t = currentTrack();
        syncDockLyric(t);
        if (modal.classList.contains("open") && $("rmx-lyrics-line")) renderLyrics(t);

        if (featureData.crossfade && audio.duration && audio.duration - audio.currentTime <= 5 && !audio.__rmxFading) {
            audio.__rmxFading = true;
            userManuallyPaused = true;
            const baseVol = audio.volume, start = Date.now(), dur = Math.max(500, (audio.duration - audio.currentTime) * 1000);
            const fade = setInterval(function () {
                if (audio.paused || audio.duration - audio.currentTime > 6) {
                    clearInterval(fade); audio.__rmxFading = false;
                    userManuallyPaused = audio.paused; audio.volume = baseVol; return;
                }
                const p = Math.min(1, (Date.now() - start) / dur);
                audio.volume = baseVol * (1 - p);
                if (p >= 1) {
                    clearInterval(fade); audio.__rmxFading = false; audio.volume = baseVol;
                    const curT = currentTrack(); if (curT) markSongAsPlayed(curT.id);
                    advanceToNextTrack();
                }
            }, 100);
        }
    });

    /* Lock-screen artwork */
    const oldMediaUpdate = updateMediaSession;
    updateMediaSession = function (track) {
        oldMediaUpdate(track);
        if (!("mediaSession" in navigator) || !track) return;
        try {
            const m = metaFor(track.id);
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title, artist: track.director, album: "Rishi Music",
                artwork: m.art ? [{ src: m.art, sizes: "256x256", type: "image/jpeg" }] : []
            });
        } catch (e) { console.warn("Lock-screen artwork unavailable:", e); }
    };

    /* Voice search */
    if (searchInput && !$("rmx-voice-search")) {
        const voice = document.createElement("button");
        voice.id = "rmx-voice-search"; voice.className = "rmx-btn"; voice.textContent = "🎙 Voice";
        searchInput.insertAdjacentElement("afterend", voice);
        voice.onclick = function () {
            const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SR) return alert("Voice search isn't supported by this browser. Try Chrome.");
            const rec = new SR();
            rec.lang = navigator.language || "en-IN"; rec.interimResults = false; rec.maxAlternatives = 1;
            rec.onstart = function () { voice.textContent = "🎙 Listening…"; };
            rec.onend = function () { voice.textContent = "🎙 Voice"; };
            rec.onresult = function (e) {
                searchInput.value = e.results[0][0].transcript;
                searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            };
            rec.onerror = function () { alert("Voice search could not start. Check microphone permission."); };
            rec.start();
        };
    }

    /* Themes */
    function showTheme() {
        const presets = { Blue: "#1d72fe", Purple: "#8b5cf6", Cyan: "#06b6d4", Green: "#16a34a", Pink: "#ec4899", Orange: "#f97316" };
        openModal("Accent Theme",
            '<p class="rmx-muted">Choose an accent colour. It is saved with your settings.</p><div class="rmx-actions">' +
            Object.keys(presets).map(function (n) { return '<button class="rmx-btn" data-color="' + presets[n] + '">' + n + "</button>"; }).join("") +
            '<input type="color" id="rmx-custom-theme" value="' + appSettings.accent + '"></div>');
        modalContent.querySelectorAll("[data-color]").forEach(function (b) { b.onclick = function () { updateSetting({ accent: b.dataset.color }); }; });
        $("rmx-custom-theme").oninput = function (e) { updateSetting({ accent: e.target.value }); };
    }

    /* Mini player */
    $("rmx-mini-toggle").onclick = function () {
        document.body.classList.toggle("rmx-mini");
        $("rmx-mini-toggle").textContent = document.body.classList.contains("rmx-mini") ? "Expand Player" : "Mini Player";
    };

    $("rmx-tools").addEventListener("click", function (e) {
        const key = e.target.closest("[data-open]");
        if (!key) return;
        const map = {
            voicedj: showVoiceDjModal,
            player: showPlayer,
            queue: showQueue,
            playlists: showPlaylists,
            folders: showFolders,
            audio: showAudioSettings,
            backup: showBackup,
            stats: showStats,
            theme: showTheme
        };
        if (map[key.dataset.open]) map[key.dataset.open]();
    });

    /* Fade-in on new track when crossfade is on, refresh player sheet & lyrics */
    const oldLoad = loadTrackSource;
    loadTrackSource = async function (index) {
        const ok = await oldLoad(index);
        if (ok) {
            if (featureData.crossfade) { audio.volume = 0; fadeInPending = true; }
            updateDashboard();
            syncDockLyric(currentTrack());
            if (modal.classList.contains("open") && modalTitle.textContent.indexOf("Player") === 0) showPlayer();
        }
        return ok;
    };

    if (featureData.effects) {
        document.addEventListener("click", function once() { setupAudioGraph(); document.removeEventListener("click", once); }, { once: true });
    }
    updateDashboard();
    syncDockLyric(currentTrack());
    setInterval(updateDashboard, 15000);
})();