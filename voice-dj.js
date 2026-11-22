"use strict";

/* ============================================================
   RISHI VOICE DJ (LADIES VOICE) + AUTO SYNCED LYRICS
   Connects directly to index.html (#sm, #dock, window.RishiBridge)
   ============================================================ */
(function initRishiVoiceDJ() {
  const $ = id => document.getElementById(id);
  const LS = localStorage;

  const jget = (k, d) => {
    try { return JSON.parse(LS.getItem(k)) || d; } catch (_) { return d; }
  };
  const jset = (k, v) => {
    try { LS.setItem(k, JSON.stringify(v)); } catch (_) {}
  };

  let prefs = {
    aiDj: true,
    voiceGender: "female",   // Default: Ladies (Female) voice
    voiceLang: "en-US",      // "en-US" | "ta-IN"
    liveAiLyrics: true,
    lyricsLang: "ta-IN",     // "ta-IN" | "en-US"
    ...jget("rishi_voice_prefs_v6", {})
  };
  const savePrefs = () => jset("rishi_voice_prefs_v6", prefs);

  const au = $("au");
  if (!au) return;

  /* ------------------------------------------------------------
     1. TAMIL -> ENGLISH PHONETIC TRANSLITERATION & CLEANERS
     ------------------------------------------------------------ */
  const TAMIL_VOWELS = {
    "அ": "a", "ஆ": "aa", "இ": "i", "ஈ": "ee", "உ": "u", "ஊ": "oo",
    "எ": "e", "ஏ": "ae", "ஐ": "ai", "ஒ": "o", "ஓ": "oo", "ஔ": "au"
  };
  const TAMIL_CONSONANTS = {
    "க": "k", "ங": "ng", "ச": "s", "ஞ": "nj", "ட": "t", "ண": "n",
    "த": "th", "ந": "n", "ப": "p", "ம": "m", "ய": "y", "ர": "r",
    "ல": "l", "வ": "v", "ழ": "zh", "ள": "l", "ற": "r", "ன": "n",
    "ஜ": "j", "ஷ": "sh", "ஸ": "s", "ஹ": "h", "க்ஷ": "ksh"
  };
  const TAMIL_MARKS = {
    "ா": "aa", "ி": "i", "ீ": "ee", "ு": "u", "ூ": "oo",
    "ெ": "e", "ே": "ae", "ை": "ai", "ொ": "o", "ோ": "oo", "ௌ": "au",
    "்": ""
  };

  function tamilToEnglishPhonetic(input) {
    const str = String(input || "");
    if (!/[\u0B80-\u0BFF]/.test(str)) return str;

    let out = "";
    const chars = Array.from(str);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const next = chars[i + 1];
      if (TAMIL_VOWELS[ch]) {
        out += TAMIL_VOWELS[ch];
      } else if (TAMIL_CONSONANTS[ch]) {
        let base = TAMIL_CONSONANTS[ch];
        if (i > 0 && chars[i - 1] !== " ") {
          if (ch === "ப") base = "b";
          if (ch === "ட") base = "d";
          if (ch === "க") base = "g";
          if (ch === "ச") base = "ch";
        }
        if (next && Object.prototype.hasOwnProperty.call(TAMIL_MARKS, next)) {
          out += base + TAMIL_MARKS[next];
          i++;
        } else {
          out += base + "a";
        }
      } else {
        out += ch;
      }
    }
    return out;
  }

  function cleanDisplay(s) {
    return String(s || "")
      .replace(/\.[a-z0-9]{2,4}$/i, "")
      .replace(/[\[\(\{].*?[\]\)\}]/g, " ")
      .replace(/[_\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function skeleton(s) {
    return tamilToEnglishPhonetic(s)
      .toLowerCase()
      .replace(/\.[a-z0-9]{2,4}$/i, "")
      .replace(/[\[\(\{].*?[\]\)\}]/g, "")
      .replace(/[^a-z0-9]+/g, "")
      .replace(/aa+/g, "a")
      .replace(/ee+|ii+/g, "i")
      .replace(/oo+|uu+/g, "u")
      .replace(/th/g, "t")
      .replace(/sh|zh/g, "s")
      .replace(/b/g, "p")
      .replace(/d/g, "t")
      .replace(/g/g, "k")
      .replace(/v/g, "w")
      .replace(/(.)\1+/g, "$1");
  }

  /* ------------------------------------------------------------
     2. FLOATING BLUE GLOSSY VOICE DJ BUTTON & CARD
     ------------------------------------------------------------ */
  const style = document.createElement("style");
  style.textContent = `
    #rvdj-widget {
      position: fixed;
      right: 14px;
      bottom: calc(140px + env(safe-area-inset-bottom));
      z-index: 9;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: calc(100vw - 28px);
      pointer-events: none;
    }
    body.compact #rvdj-widget {
      bottom: calc(84px + env(safe-area-inset-bottom));
    }
    #rvdj-card {
      pointer-events: auto;
      display: none;
      flex-direction: column;
      gap: 4px;
      min-width: 215px;
      max-width: 290px;
      padding: 11px 14px;
      border-radius: 18px;
      background: linear-gradient(145deg, rgba(23,38,65,.96), rgba(11,21,37,.97));
      border: 1px solid rgba(101,197,255,.38);
      box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 22px rgba(29,114,254,.35);
      color: #f5f9ff;
      font-size: 12px;
    }
    #rvdj-card.open { display: flex; }
    .rvdj-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-weight: 800;
      font-size: 11px;
      letter-spacing: .6px;
      text-transform: uppercase;
      color: #65c5ff;
    }
    .rvdj-lang-pill {
      border: 1px solid rgba(101,197,255,.4);
      background: rgba(29,114,254,.25);
      color: #fff;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
    }
    #rvdj-heard { color: #9bb3d4; font-style: italic; overflow-wrap: anywhere; }
    #rvdj-reply { color: #fff; font-weight: 700; line-height: 1.4; overflow-wrap: anywhere; }
    #rvdj-fab {
      pointer-events: auto;
      width: 54px;
      height: 54px;
      border-radius: 50%;
      border: 1px solid rgba(101,197,255,.5);
      background: linear-gradient(135deg, #65c5ff, #1d72fe, #0755d9);
      color: #fff;
      font-size: 22px;
      display: grid;
      place-items: center;
      cursor: pointer;
      flex: none;
      box-shadow: 0 6px 22px rgba(29,114,254,.55), inset 0 1px 2px rgba(255,255,255,.45);
    }
    #rvdj-widget.listening #rvdj-fab {
      animation: rvdjGlow 1.1s infinite;
    }
    @keyframes rvdjGlow {
      0%   { box-shadow: 0 0 0 0 rgba(101,197,255,.75), 0 0 24px rgba(29,114,254,.8); }
      70%  { box-shadow: 0 0 0 16px rgba(101,197,255,0), 0 0 28px rgba(29,114,254,.9); }
      100% { box-shadow: 0 0 0 0 rgba(101,197,255,0), 0 0 24px rgba(29,114,254,.8); }
    }
  `;
  document.head.appendChild(style);

  const widget = document.createElement("div");
  widget.id = "rvdj-widget";
  widget.innerHTML = `
    <div id="rvdj-card">
      <div class="rvdj-head">
        <span>✦ Rishi Voice DJ</span>
        <button type="button" class="rvdj-lang-pill" id="rvdj-lang-toggle">
          ${prefs.voiceLang === "ta-IN" ? "தமிழ் / EN" : "EN / தமிழ்"}
        </button>
      </div>
      <div id="rvdj-heard">Tap mic &amp; speak</div>
      <div id="rvdj-reply">Try: "Play a song" or "Pause"</div>
    </div>
    <button type="button" id="rvdj-fab" title="Rishi Voice DJ">🎙️</button>
  `;
  document.body.appendChild(widget);

  let hideCardTimer = null;
  function showCard(ms = 0) {
    $("rvdj-card").classList.add("open");
    clearTimeout(hideCardTimer);
    if (ms > 0) {
      hideCardTimer = setTimeout(() => {
        if (!widget.classList.contains("listening")) $("rvdj-card").classList.remove("open");
      }, ms);
    }
  }

  /* ------------------------------------------------------------
     3. LADIES (FEMALE) & MALE VOICE SYNTHESIS
     ------------------------------------------------------------ */
  let cachedVoices = [];
  function loadVoices() {
    if (!("speechSynthesis" in window)) return;
    const v = window.speechSynthesis.getVoices();
    if (v && v.length) cachedVoices = v;
  }
  loadVoices();
  if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = loadVoices;

  function pickSystemVoice(lang, gender) {
    loadVoices();
    if (!cachedVoices.length) return null;
    const isTa = lang.toLowerCase().startsWith("ta");
    const pool = cachedVoices.filter(v =>
      isTa ? v.lang.toLowerCase().includes("ta") : v.lang.toLowerCase().startsWith("en")
    );
    const list = pool.length ? pool : cachedVoices;

    const femaleKeys = [
      "female", "woman", "girl", "zira", "samantha", "victoria", "heera",
      "kalpana", "shruti", "veena", "aria", "jenny", "sfg", "tpc"
    ];
    const maleKeys = [
      "male", "man", "boy", "david", "mark", "ravi", "hemant", "daniel",
      "alex", "rishi", "prabhat", "guy", "iol", "iom"
    ];
    const keys = gender === "male" ? maleKeys : femaleKeys;

    const match = list.find(v => keys.some(k => v.name.toLowerCase().includes(k)));
    if (match) return match;
    if (list.length > 1) return gender === "male" ? list[list.length - 1] : list[0];
    return list[0];
  }

  function speakRishi(text, onDone) {
    $("rvdj-reply").textContent = text;
    if ($("aiDjStatus")) $("aiDjStatus").textContent = text;
    showCard();

    if (!("speechSynthesis" in window)) {
      if (onDone) onDone();
      return;
    }

    try { window.speechSynthesis.cancel(); } catch (_) {}

    const utter = new SpeechSynthesisUtterance(text);
    const isTamilText = /[\u0B80-\u0BFF]/.test(text);
    const lang = isTamilText ? "ta-IN" : "en-US";
    utter.lang = lang;

    const v = pickSystemVoice(lang, prefs.voiceGender);
    if (v) {
      utter.voice = v;
      utter.lang = v.lang;
    }

    if (prefs.voiceGender === "male") {
      utter.pitch = 0.62;
      utter.rate = 0.95;
    } else {
      utter.pitch = 1.42;
      utter.rate = 1.04;
    }
    utter.volume = 1.0;

    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        if (onDone) onDone();
      }
    };
    utter.onend = finish;
    utter.onerror = finish;
    setTimeout(finish, Math.max(2000, text.length * 100));
    window.speechSynthesis.speak(utter);
  }

  /* ------------------------------------------------------------
     4. AUTOMATIC SYNCED LYRICS (LRCLIB + MIC FALLBACK)
     ------------------------------------------------------------ */
  const fetchedIds = new Set();

  function setLyricsStatus(msg) {
    if ($("liveAiLyricsStatus")) $("liveAiLyricsStatus").textContent = msg;
  }

  async function autoFetchLyrics(track) {
    if (!prefs.liveAiLyrics || !track || !window.RishiBridge) return;

    const existing = window.RishiBridge.getLyricsForTrack(track.id);
    if (existing && existing.trim()) {
      setLyricsStatus("♪ Synced lyrics active");
      if ($("liveLyricBar")) $("liveLyricBar").style.display = "block";
      return;
    }

    if (fetchedIds.has(track.id)) {
      startMicLyricsFallback();
      return;
    }
    fetchedIds.add(track.id);

    const titleClean = cleanDisplay(track.title);
    const artistClean = track.director && track.director !== "UNKNOWN DIRECTOR"
      ? cleanDisplay(track.director)
      : "";

    setLyricsStatus(`🔍 Fetching lyrics for "${titleClean}"...`);
    if ($("liveLyricBar")) {
      $("liveLyricBar").style.display = "block";
      $("liveLyricBar").textContent = `🔍 Finding lyrics for ${titleClean}...`;
    }

    try {
      const q = encodeURIComponent(`${titleClean} ${artistClean}`.trim());
      const res = await fetch(`https://lrclib.net/api/search?q=${q}`);
      if (res.ok) {
        const items = await res.json();
        const best = Array.isArray(items)
          ? (items.find(x => x.syncedLyrics) || items.find(x => x.plainLyrics))
          : null;

        if (best && (best.syncedLyrics || best.plainLyrics)) {
          window.RishiBridge.setFullLyrics(track.id, best.syncedLyrics || best.plainLyrics);
          setLyricsStatus("♪ Synced lyrics loaded automatically");
          if ($("liveLyricBar")) $("liveLyricBar").style.display = "block";
          return;
        }
      }
    } catch (_) {}

    startMicLyricsFallback();
  }

  let micLyricRec = null;
  let lastInterim = "";
  let commitTimer = null;

  function startMicLyricsFallback() {
    if (!prefs.liveAiLyrics || isListening || au.paused) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || micLyricRec) return;

    micLyricRec = new SR();
    micLyricRec.lang = ($("lyricsLangSelect") && $("lyricsLangSelect").value) || prefs.lyricsLang || "ta-IN";
    micLyricRec.continuous = true;
    micLyricRec.interimResults = true;

    micLyricRec.onstart = () => setLyricsStatus("🎤 Listening for live lyrics...");

    micLyricRec.onresult = e => {
      const curTrack = window.RishiBridge && window.RishiBridge.getCurrentTrack();
      if (au.paused || !curTrack) return;

      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;

        if (res.isFinal) {
          clearTimeout(commitTimer);
          lastInterim = "";
          const sec = au.currentTime || 0;
          const m = String(Math.floor(sec / 60)).padStart(2, "0");
          const s = (sec % 60).toFixed(2).padStart(5, "0");
          window.RishiBridge.appendAutoLyric(curTrack.id, `[${m}:${s}]${text}`);
        } else {
          interim = text;
        }
      }

      if (interim) {
        lastInterim = interim;
        if ($("liveLyricBar")) {
          $("liveLyricBar").style.display = "block";
          $("liveLyricBar").textContent = `♪ ${interim}`;
        }
        clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
          if (lastInterim && !au.paused) {
            const sec = au.currentTime || 0;
            const m = String(Math.floor(sec / 60)).padStart(2, "0");
            const s = (sec % 60).toFixed(2).padStart(5, "0");
            window.RishiBridge.appendAutoLyric(curTrack.id, `[${m}:${s}]${lastInterim}`);
            lastInterim = "";
          }
        }, 2800);
      }
    };

    micLyricRec.onend = () => {
      micLyricRec = null;
      clearTimeout(commitTimer);
      if (prefs.liveAiLyrics && !au.paused && !isListening) {
        setTimeout(startMicLyricsFallback, 300);
      }
    };

    try { micLyricRec.start(); } catch (_) { micLyricRec = null; }
  }

  function stopMicLyricsFallback() {
    clearTimeout(commitTimer);
    if (micLyricRec) {
      try { micLyricRec.abort(); } catch (_) {}
      micLyricRec = null;
    }
  }

  /* ------------------------------------------------------------
     5. VOICE COMMAND MATCHING & EXECUTION
     ------------------------------------------------------------ */
  function findMatchingIndices(queryRaw) {
    const list = (window.RishiBridge && window.RishiBridge.getTracks()) || [];
    if (!list.length) return [];

    const cleaned = queryRaw
      .replace(/^(hey\s+rishi|rishi|ok\s+rishi|ஹே\s+ரிஷி|ரிஷி)[,\s]*/i, "")
      .replace(/\b(play|songs?|music|tracks?|by|from|of|the|my|please|podu|paattu|paadal|பாட்டு|பாடல்|பாடல்கள்|போடு)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return [];

    const phonetic = tamilToEnglishPhonetic(cleaned);
    const qSkel = skeleton(phonetic);
    const words = phonetic.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length >= 2);

    const scored = [];
    list.forEach((track, idx) => {
      const tSkel = skeleton(track.title);
      const dSkel = skeleton(track.director);
      const tLow = cleanDisplay(track.title).toLowerCase();
      const dLow = cleanDisplay(track.director).toLowerCase();
      let score = 0;

      if (qSkel && tSkel === qSkel) score += 120;
      else if (qSkel && tSkel.includes(qSkel) && qSkel.length >= 3) score += 85;
      else if (tSkel && qSkel.includes(tSkel) && tSkel.length >= 3) score += 80;
      if (qSkel && dSkel && (dSkel.includes(qSkel) || qSkel.includes(dSkel)) && qSkel.length >= 3) score += 90;

      words.forEach(w => {
        const ws = skeleton(w);
        if (ws.length >= 3 && tSkel.includes(ws)) score += 25;
        if (ws.length >= 3 && dSkel.includes(ws)) score += 30;
        if (tLow.includes(w)) score += 20;
        if (dLow.includes(w)) score += 25;
      });

      if (score >= 25) scored.push({ idx, score });
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map(x => x.idx);
  }

  async function executeVoiceCommand(transcripts) {
    const bridge = window.RishiBridge;
    const list = (bridge && bridge.getTracks()) || [];
    const isTa = prefs.voiceLang === "ta-IN";
    const primary = transcripts[0] || "";
    const cmd = primary.toLowerCase().replace(/^(hey\s+rishi|rishi|ok\s+rishi)[,\s]*/i, "").trim();

    if (/(what\s+song|which\s+song|current\s+song|now\s+playing|என்ன\s+பாட்டு)/.test(cmd)) {
      const cur = bridge && bridge.getCurrentTrack();
      speakRishi(cur
        ? (isTa ? `இப்போது ${cleanDisplay(cur.title)} ஒலிக்கிறது.` : `Now playing ${cleanDisplay(cur.title)} by ${cleanDisplay(cur.director)}.`)
        : (isTa ? "இப்போது எந்தப் பாடலும் ஒலிக்கவில்லை." : "No song is playing right now."));
      showCard(5000);
      return;
    }

    if (/(pause|stop\s+music|stop\s+song|நிறுத்து)/.test(cmd)) {
      au.pause();
      speakRishi(isTa ? "இசை நிறுத்தப்பட்டது." : "Music paused.");
      showCard(4000);
      return;
    }

    if (/^(resume|continue|play\s+music|தொடர்)$/.test(cmd)) {
      if ($("play")) $("play").click();
      speakRishi(isTa ? "பாடல் தொடர்கிறது." : "Resuming music.");
      showCard(4000);
      return;
    }

    if (/(next|skip|அடுத்த)/.test(cmd)) {
      if ($("next")) $("next").click();
      speakRishi(isTa ? "அடுத்த பாடல் ஒலிக்கிறது." : "Playing next song.");
      showCard(4000);
      return;
    }

    if (/(previous|prev|back|முந்தைய)/.test(cmd)) {
      if ($("prev")) $("prev").click();
      speakRishi(isTa ? "முந்தைய பாடல்." : "Playing previous song.");
      showCard(4000);
      return;
    }

    if (/(shuffle|கலக்கு)/.test(cmd)) {
      if ($("shufBtn") && !$("shufBtn").classList.contains("on")) $("shufBtn").click();
      if (list.length && bridge) {
        await bridge.playIndex(Math.floor(Math.random() * list.length));
      }
      speakRishi(isTa ? "பிளேலிஸ்ட் ஷஃபிள் செய்யப்பட்டது." : "Playlist shuffled.");
      showCard(4000);
      return;
    }

    if (/(increase\s+volume|volume\s+up|louder|சத்தம்\s+அதிகரி)/.test(cmd)) {
      const nextVol = Math.min(1, au.volume + 0.2);
      au.volume = nextVol;
      const pct = Math.round(nextVol * 100);
      if ($("vol")) { $("vol").value = pct; $("vol").dispatchEvent(new Event("input")); }
      speakRishi(`Volume increased to ${pct} percent.`);
      showCard(4000);
      return;
    }

    if (/(decrease\s+volume|volume\s+down|lower\s+volume|சத்தம்\s+குறை)/.test(cmd)) {
      const nextVol = Math.max(0.1, au.volume - 0.2);
      au.volume = nextVol;
      const pct = Math.round(nextVol * 100);
      if ($("vol")) { $("vol").value = pct; $("vol").dispatchEvent(new Event("input")); }
      speakRishi(`Volume decreased to ${pct} percent.`);
      showCard(4000);
      return;
    }

    if (/(favou?rite|liked|பிடித்த)/.test(cmd)) {
      const favIds = jget("rishi_favs", []);
      const favIdx = list.map((t, i) => i).filter(i => favIds.includes(list[i].id));
      if (!favIdx.length) {
        speakRishi("You don't have any favourite songs yet.");
        showCard(4500);
        return;
      }
      const pick = favIdx[Math.floor(Math.random() * favIdx.length)];
      speakRishi(`Playing favourite: ${cleanDisplay(list[pick].title)}`, async () => {
        if (bridge) await bridge.playIndex(pick);
      });
      showCard(5000);
      return;
    }

    if (!list.length) {
      speakRishi("Your library is empty. Please import songs first.");
      showCard(4500);
      return;
    }

    if (/^(play\s+a\s+song|play\s+music|play\s+anything|play|பாட்டு\s+போடு)$/.test(cmd)) {
      const rnd = Math.floor(Math.random() * list.length);
      speakRishi(`Playing ${cleanDisplay(list[rnd].title)}`, async () => {
        if (bridge) await bridge.playIndex(rnd);
      });
      showCard(5000);
      return;
    }

    let matches = [];
    for (const alt of transcripts) {
      matches = findMatchingIndices(alt);
      if (matches.length) break;
    }

    if (matches.length) {
      if (matches.length > 1 && $("shufBtn") && !$("shufBtn").classList.contains("on")) {
        $("shufBtn").click();
      }
      const pick = matches[Math.floor(Math.random() * matches.length)];
      speakRishi(`Playing ${cleanDisplay(list[pick].title)}`, async () => {
        if (bridge) await bridge.playIndex(pick);
      });
      showCard(5000);
    } else {
      const rnd = Math.floor(Math.random() * list.length);
      speakRishi(`I couldn't find ${tamilToEnglishPhonetic(primary)}, playing ${cleanDisplay(list[rnd].title)} instead.`, async () => {
        if (bridge) await bridge.playIndex(rnd);
      });
      showCard(5500);
    }
  }

  /* ------------------------------------------------------------
     6. INSTANT TAP-TO-LISTEN SPEECH RECOGNITION
     ------------------------------------------------------------ */
  let recognition = null;
  let isListening = false;

  function stopListening() {
    isListening = false;
    widget.classList.remove("listening");
    if (recognition) {
      try { recognition.abort(); } catch (_) {}
      recognition = null;
    }
  }

  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert("Voice recognition requires Google Chrome over HTTPS.");
      return;
    }

    if (isListening) {
      stopListening();
      return;
    }

    stopMicLyricsFallback();
    const wasPlaying = !au.paused;
    if (wasPlaying) au.pause();
    try { window.speechSynthesis.cancel(); } catch (_) {}

    const lang = prefs.voiceLang === "ta-IN" ? "ta-IN" : "en-US";
    recognition = new SR();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;

    recognition.onstart = () => {
      isListening = true;
      widget.classList.add("listening");
      $("rvdj-heard").textContent = lang === "ta-IN" ? "🎙️ கேட்கிறேன்..." : "🎙️ Listening...";
      $("rvdj-reply").textContent = "Say a song, music director, or command";
      showCard();
    };

    recognition.onresult = e => {
      let interim = "";
      const finalAlts = [];
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          for (let j = 0; j < res.length; j++) finalAlts.push(res[j].transcript.trim());
        } else {
          interim += res[0].transcript;
        }
      }
      if (interim) $("rvdj-heard").textContent = `You: "${interim.trim()}"`;
      if (finalAlts.length) {
        stopListening();
        $("rvdj-heard").textContent = `You said: "${finalAlts[0]}"`;
        executeVoiceCommand(finalAlts);
      }
    };

    recognition.onerror = err => {
      stopListening();
      $("rvdj-reply").textContent = err.error === "not-allowed"
        ? "Please allow microphone access in Chrome."
        : err.error === "network"
        ? "Internet required for voice recognition."
        : "Didn't catch that. Tap mic again.";
      showCard(4500);
      if (wasPlaying && $("play")) $("play").click();
    };

    recognition.onend = () => {
      isListening = false;
      widget.classList.remove("listening");
      recognition = null;
    };

    try {
      recognition.start();
    } catch (e) {
      stopListening();
    }
  }

  $("rvdj-fab").onclick = startListening;

  $("rvdj-lang-toggle").onclick = () => {
    prefs.voiceLang = prefs.voiceLang === "ta-IN" ? "en-US" : "ta-IN";
    savePrefs();
    $("rvdj-lang-toggle").textContent = prefs.voiceLang === "ta-IN" ? "தமிழ் / EN" : "EN / தமிழ்";
    if ($("djLangSelect")) $("djLangSelect").value = prefs.voiceLang;
    speakRishi(prefs.voiceLang === "ta-IN" ? "தமிழ் குரல் தேர்வு செய்யப்பட்டது." : "English voice selected.");
    showCard(3500);
  };

  /* ------------------------------------------------------------
     7. BIND SETTINGS CONTROLS & AUDIO HOOKS
     ------------------------------------------------------------ */
  if ($("djGenderSelect")) {
    $("djGenderSelect").value = prefs.voiceGender;
    $("djGenderSelect").onchange = e => {
      prefs.voiceGender = e.target.value;
      savePrefs();
      speakRishi(prefs.voiceGender === "male" ? "Male voice activated." : "Ladies voice activated.");
    };
  }
  if ($("djLangSelect")) {
    $("djLangSelect").value = prefs.voiceLang;
    $("djLangSelect").onchange = e => {
      prefs.voiceLang = e.target.value;
      savePrefs();
      $("rvdj-lang-toggle").textContent = prefs.voiceLang === "ta-IN" ? "தமிழ் / EN" : "EN / தமிழ்";
      speakRishi(prefs.voiceLang === "ta-IN" ? "தமிழ் மொழி தேர்வு செய்யப்பட்டது." : "English language selected.");
    };
  }
  if ($("liveAiLyricsToggle")) {
    $("liveAiLyricsToggle").checked = !!prefs.liveAiLyrics;
    $("liveAiLyricsToggle").onchange = e => {
      prefs.liveAiLyrics = e.target.checked;
      savePrefs();
      if (prefs.liveAiLyrics) {
        const cur = window.RishiBridge && window.RishiBridge.getCurrentTrack();
        if (cur) autoFetchLyrics(cur);
      } else {
        stopMicLyricsFallback();
        setLyricsStatus("Auto AI Lyrics: Off");
      }
    };
  }
  if ($("lyricsLangSelect")) {
    $("lyricsLangSelect").value = prefs.lyricsLang;
    $("lyricsLangSelect").onchange = e => {
      prefs.lyricsLang = e.target.value;
      savePrefs();
    };
  }
  if ($("startVoiceChatBtn")) {
    $("startVoiceChatBtn").onclick = () => {
      if ($("sm")) $("sm").classList.remove("open");
      startListening();
    };
  }
  if ($("stopVoiceChatBtn")) {
    $("stopVoiceChatBtn").onclick = stopListening;
  }

  if (window.RishiBridge) {
    window.RishiBridge.getVoiceLang = () => prefs.voiceLang;
    window.RishiBridge.toEnglishPhonetic = tamilToEnglishPhonetic;
  }

  au.addEventListener("play", () => {
    const cur = window.RishiBridge && window.RishiBridge.getCurrentTrack();
    if (cur) autoFetchLyrics(cur);
  });
  au.addEventListener("loadedmetadata", () => {
    const cur = window.RishiBridge && window.RishiBridge.getCurrentTrack();
    if (cur) autoFetchLyrics(cur);
  });
  au.addEventListener("pause", stopMicLyricsFallback);
  au.addEventListener("ended", stopMicLyricsFallback);
})();