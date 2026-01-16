/* app.js */
/**
 * You vs Everyone (single-page)
 *
 * Local:
 * - Theme toggle (persisted)
 * - Hub + 3 active modes
 * - Deterministic daily seed (UTC day)
 * - Anti-cheat / focus rule (15s away) via Page Visibility API
 * - Share text + copy + downloadable image via Canvas
 *
 * Supabase (Auth mode):
 * - profiles: display_name + circle_style
 * - daily_runs: 24h challenge
 * - sessions: bossFight / focusArena
 * - presence: lightweight mode + last_seen
 */

(function () {
  "use strict";

  // -----------------------------
  // Utilities: date, seed, random
  // -----------------------------
  const pad2 = (n) => String(n).padStart(2, "0");
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // UTC day key: stable for everyone
  function utcDayKey(d = new Date()) {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  function minutesToMs(m) { return m * 60 * 1000; }

  function msToClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${pad2(mm)}:${pad2(ss)}`;
  }

  function msToResetCountdown(ms) {
    // show HH:MM:SS
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  }

  function nextUtcMidnight(d = new Date()) {
    const n = new Date(d);
    // Next 00:00:00Z
    n.setUTCDate(n.getUTCDate() + 1);
    n.setUTCHours(0, 0, 0, 0);
    return n;
  }

  // Deterministic hash -> uint32
  function hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Mulberry32 PRNG
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function todaySeed(salt = "") {
    const key = utcDayKey();
    return hash32(`yve:${key}:${salt}`);
  }

  // -----------------------------
  // Storage
  // -----------------------------
  const LS = {
    theme: "yve_theme",
    userMode: "yve_user_mode", // 'anon' | 'auth'
    streak: "yve_streak",
    lastStreakDay: "yve_streak_last_day", // UTC day
    todayState: "yve_today_state", // 24h challenge (UTC): {dayKey, state, startedAt, resultAt, challengeId}
    bossHistory: "yve_boss_history",
    arenaHistory: "yve_arena_history",
    arenaBadges: "yve_arena_badges" // integer
  };

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn("saveJSON failed", e);
    }
  }

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function showScreen(id) {
    $$(".screen").forEach(s => s.classList.remove("active"));
    const el = $(id);
    if (el) el.classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });

    // Presence: update mode when screen changes
    if (id === "#screenHome") presenceSetMode("hub");
    if (id === "#screenChallenge24") presenceSetMode("challenge24");
    if (id === "#screenBossFight") presenceSetMode("bossFight");
    if (id === "#screenFocusArena") presenceSetMode("focusArena");
  }

  // -----------------------------
  // Escape helpers
  // -----------------------------
  function escapeHTML(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // -----------------------------
  // Toasts + Modal
  // -----------------------------
  const toastWrap = $("#toastWrap");
  function toast(title, body, ms = 2600) {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `
      <div class="toast-title">${escapeHTML(title)}</div>
      <div class="toast-body">${escapeHTML(body)}</div>
      <div class="row"><span class="mini">local-only</span><span class="mini">ok</span></div>
    `;
    toastWrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(6px)";
      el.style.transition = "opacity .18s ease, transform .18s ease";
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  const modalBackdrop = $("#modalBackdrop");
  const modalTitle = $("#modalTitle");
  const modalBody = $("#modalBody");
  const modalActions = $("#modalActions");
  const modalClose = $("#modalClose");

  let modalLocked = false;

  function openModal({ title, body, actions, locked = false }) {
    modalLocked = !!locked;
    modalTitle.textContent = title;
    modalBody.innerHTML = body;
    modalActions.innerHTML = "";
    (actions || []).forEach(a => {
      const btn = document.createElement("button");
      btn.className = `btn ${a.variant || ""}`.trim();
      btn.type = "button";
      btn.textContent = a.label;
      btn.addEventListener("click", () => a.onClick && a.onClick());
      modalActions.appendChild(btn);
    });

    modalBackdrop.hidden = false;
    modalClose.style.display = modalLocked ? "none" : "";
  }

  function closeModal() {
    if (modalLocked) return;
    modalBackdrop.hidden = true;
  }

  function closeModalForce() {
    modalLocked = false;
    modalBackdrop.hidden = true;
    modalClose.style.display = "";
  }

  modalClose.addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeModal();
  });

  // -----------------------------
  // Theme
  // -----------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const icon = $("#themeToggle .icon");
    if (icon) icon.textContent = theme === "light" ? "☀" : "☾";
  }

  function initTheme() {
    const saved = localStorage.getItem(LS.theme);
    const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    const theme = saved || (prefersLight ? "light" : "dark");
    applyTheme(theme);

    $("#themeToggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || "dark";
      const next = cur === "dark" ? "light" : "dark";
      localStorage.setItem(LS.theme, next);
      applyTheme(next);
      toast("Theme", next === "dark" ? "Dark mode. Serious business." : "Light mode. Still serious.");
    });
  }

  // -----------------------------
  // Supabase (Auth + DB)
  // -----------------------------
  // Put YOUR keys here (publishable/anon is OK for browser with RLS).
  const SUPABASE_URL = "https://caehrwokvrdjlojnwnfzb.supabase.co";
  const SUPABASE_KEY = "sb_publishable_tl7q_CylF_YFH0Vu0D-2qg_flzagSsL";

  let supabase = null;
  let authUser = null;     // Supabase user
  let authProfile = null;  // public.profiles row

  function initSupabase() {
    if (!window.supabase || !window.supabase.createClient) {
      console.warn("Supabase JS not found. Auth will be unavailable.");
      return;
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }

  async function refreshAuthUser() {
    if (!supabase) return null;
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    authUser = data.user || null;
    return authUser;
  }

  function getUserMode() {
    return localStorage.getItem(LS.userMode); // 'anon' | 'auth' | null
  }
  function setUserMode(mode) {
    localStorage.setItem(LS.userMode, mode);
  }

  async function signOut() {
    if (!supabase) return;
    try { await supabase.auth.signOut(); } catch { /* ignore */ }
    authUser = null;
    authProfile = null;
    setUserMode("anon");
    updateAccountPill();
  }

  // -----------------------------
  // DB helpers (Auth mode only)
  // -----------------------------
  function isAuthActive() {
    return getUserMode() === "auth" && !!authUser;
  }

  async function dbUpsertDailyRun({ status, challengeId, startedAtISO, endedAtISO, failReason }) {
    if (!isAuthActive() || !supabase) return;
    const payload = {
      user_id: authUser.id,
      day_utc: utcDayKey(),
      challenge_id: challengeId,
      status,
      started_at: startedAtISO || null,
      ended_at: endedAtISO || null,
      fail_reason: failReason || null
    };

    const { error } = await supabase
      .from("daily_runs")
      .upsert(payload, { onConflict: "user_id,day_utc" });

    if (error) console.warn("daily_runs upsert failed", error);
  }

  async function dbInsertSession({ mode, taskName, durationMinutes, status, startedAtISO, endedAtISO }) {
    if (!isAuthActive() || !supabase) return;
    const payload = {
      user_id: authUser.id,
      mode,
      task_name: taskName || null,
      duration_minutes: durationMinutes,
      status,
      started_at: startedAtISO || new Date().toISOString(),
      ended_at: endedAtISO || new Date().toISOString(),
      day_utc: utcDayKey()
    };

    const { error } = await supabase.from("sessions").insert(payload);
    if (error) console.warn("sessions insert failed", error);
  }

  // -----------------------------
  // Presence (Auth mode only)
  // -----------------------------
  let presenceMode = "hub";
  let presenceTimer = null;

  function presenceSetMode(mode) {
    presenceMode = mode;
    presenceHeartbeat();
  }

  async function presenceHeartbeat() {
    if (!isAuthActive() || !supabase) return;

    const displayName = authProfile?.display_name || null;
    const circleStyle = authProfile?.circle_style || null;

    const payload = {
      user_id: authUser.id,
      mode: presenceMode,
      day_utc: utcDayKey(),
      last_seen_at: new Date().toISOString(),
      display_name_snapshot: displayName,
      circle_style_snapshot: circleStyle
    };

    const { error } = await supabase
      .from("presence")
      .upsert(payload, { onConflict: "user_id" });

    if (error) console.warn("presence upsert failed", error);
  }

  function startPresenceLoop() {
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = setInterval(presenceHeartbeat, 30000);

    window.addEventListener("beforeunload", () => {
      // best-effort
      presenceHeartbeat();
    });
  }

  // -----------------------------
  // Entry gate + Auth modals
  // -----------------------------
  function openEntryGateModal() {
    openModal({
      title: "Choose your entry",
      locked: true,
      body: `
        <p><b>Pick a mode.</b> Anonymous is simulated + local. Login enables real presence + DB sync.</p>
        <p class="muted" style="margin-top:10px">We don’t track you. If you log in, data is stored only in your Supabase project.</p>
      `,
      actions: [
        {
          label: "Continue anonymously",
          variant: "ghost",
          onClick: () => {
            setUserMode("anon");
            closeModalForce();
            updateAccountPill();
            renderHub();
          }
        },
        {
          label: "Log in / Register",
          variant: "primary",
          onClick: () => openAuthModal({ mode: "login" })
        }
      ]
    });
  }

  function openAuthModal({ mode, presetEmail = "" }) {
    const isRegister = mode === "register";
    const title = isRegister ? "Create account" : "Log in";

    openModal({
      title,
      locked: true,
      body: `
        <div class="field" style="margin-top:0">
          <span class="field-label">Email</span>
          <input class="input" id="authEmail" type="email" autocomplete="email" placeholder="you@example.com" value="${escapeAttr(presetEmail)}" />
        </div>
        <div class="field">
          <span class="field-label">Password</span>
          <input class="input" id="authPass" type="password" autocomplete="current-password" placeholder="••••••••" />
        </div>
        <div id="authError" style="margin-top:10px;color:var(--danger);font-weight:700"></div>
        <div class="link-inline" id="authToggle">${isRegister ? "Already have an account? Log in" : "First time here? Register"}</div>
      `,
      actions: [
        { label: "Back", variant: "ghost", onClick: () => openEntryGateModal() },
        {
          label: isRegister ? "Create account" : "Log in",
          variant: "primary",
          onClick: () => (isRegister ? doRegister() : doLogin())
        }
      ]
    });

    $("#authToggle").addEventListener("click", () => {
      const email = ($("#authEmail").value || "").trim();
      openAuthModal({ mode: isRegister ? "login" : "register", presetEmail: email });
    });

    $("#authPass").addEventListener("keydown", (e) => {
      if (e.key === "Enter") (isRegister ? doRegister() : doLogin());
    });

    function setAuthError(msg) {
      const el = $("#authError");
      if (el) el.textContent = msg;
    }

    async function doRegister() {
      if (!supabase) return setAuthError("Supabase not loaded.");
      const email = ($("#authEmail").value || "").trim();
      const password = $("#authPass").value || "";
      if (!email || password.length < 6) return setAuthError("Enter a valid email and a 6+ char password.");

      setAuthError("");

      // IMPORTANT: redirect back to your GitHub Pages URL
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin + window.location.pathname }
      });

      if (error) return setAuthError(error.message);

      // Email confirmation enabled => session may be null
      if (!data.session) {
        toast("Registered", "Check your email to confirm, then log in.");
        openAuthModal({ mode: "login", presetEmail: email });
        return;
      }

      toast("Registered", "Account created. One more step.");
      setUserMode("auth");
      authUser = data.user;
      await ensureProfileOrOnboard(authUser);
    }

    async function doLogin() {
      if (!supabase) return setAuthError("Supabase not loaded.");
      const email = ($("#authEmail").value || "").trim();
      const password = $("#authPass").value || "";
      if (!email || !password) return setAuthError("Enter email + password.");

      setAuthError("");
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return setAuthError(error.message);

      toast("Logged in", "Presence can be real now.");
      setUserMode("auth");
      authUser = data.user;

      // Close modal NOW so it never gets stuck behind profile onboarding.
      closeModalForce();
      await ensureProfileOrOnboard(authUser);
    }
  }

  async function ensureProfileOrOnboard(user) {
    if (!supabase || !user) return;

    const { data, error } = await supabase
      .from("profiles")
      .select("id, display_name, circle_style, plan")
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      console.error(error);
      toast("Profile", "Could not load profile. Check RLS/policies.");
      return;
    }

    if (!data) {
      openProfileModal(user);
      return;
    }

    authProfile = data;
    updateAccountPill();

    // Start presence updates
    presenceSetMode(presenceMode);
    startPresenceLoop();

    closeModalForce();
    renderHub();
  }

  function openProfileModal(user) {
    const COLORS = [
      "#8dd9ff", "#b2ffcc", "#ffd36b", "#ff6b6b",
      "#a98dff", "#ff8de1", "#7affff", "#7aff8d",
      "#ffb36b", "#6b8dff", "#c0c0c0", "#ffffff"
    ];

    const initialName = authProfile?.display_name || "";
    const initialStyle = authProfile?.circle_style || { type: "solid", color: COLORS[0] };
    let chosen = initialStyle?.color || COLORS[0];

    openModal({
      title: "Profile",
      locked: true,
      body: `
        <p><b>Display name</b> and circle color. (12 free colors for now.)</p>

        <div class="field">
          <span class="field-label">Display name</span>
          <input class="input" id="profileName" maxlength="24" placeholder="e.g., Nadir" value="${escapeAttr(initialName)}" />
        </div>

        <div class="field">
          <span class="field-label">Circle color</span>
          <div class="seg" id="colorSeg">
            ${COLORS.map((c) => `
              <button class="seg-btn" type="button" data-color="${c}" style="padding:10px 12px;${c === chosen ? "border-color: var(--accent);" : ""}">
                <span style="display:inline-block;width:14px;height:14px;border-radius:999px;background:${c};border:1px solid var(--border)"></span>
              </button>
            `).join("")}
          </div>
        </div>

        <div id="profileError" style="margin-top:10px;color:var(--danger);font-weight:700"></div>
      `,
      actions: [
        {
          label: "Save",
          variant: "primary",
          onClick: () => saveProfile()
        }
      ]
    });

    // Activate selected
    $$("#colorSeg .seg-btn").forEach(btn => {
      const c = btn.getAttribute("data-color");
      if (c === chosen) btn.classList.add("active");

      btn.addEventListener("click", () => {
        $$("#colorSeg .seg-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        chosen = c;
      });
    });

    $("#profileName").addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveProfile();
    });

    function setProfileError(msg) {
      const el = $("#profileError");
      if (el) el.textContent = msg;
    }

    async function saveProfile() {
      const name = ($("#profileName").value || "").trim();
      if (!name) return setProfileError("Pick a display name.");
      setProfileError("");

      const circleStyle = { type: "solid", color: chosen };
      const payload = { id: user.id, display_name: name, circle_style: circleStyle };

      const { error } = await supabase
        .from("profiles")
        .upsert(payload, { onConflict: "id" });

      if (error) {
        // unique violation on display_name
        if (String(error.code) === "23505" || String(error.message || "").toLowerCase().includes("duplicate")) {
          return setProfileError("This display name is taken. Try another.");
        }
        return setProfileError(error.message);
      }

      authProfile = { id: user.id, display_name: name, circle_style: circleStyle, plan: "free" };
      updateAccountPill();
      toast("Saved", "Profile updated.");

      closeModalForce();
      renderHub();

      // Also update presence snapshot
      presenceHeartbeat();
    }
  }

  async function ensureEntryGate() {
    const mode = getUserMode(); // 'anon' | 'auth' | null

    // Already chose anonymous
    if (mode === "anon") {
      updateAccountPill();
      return;
    }

    // Auth mode: require valid session
    if (mode === "auth") {
      const u = await refreshAuthUser();
      if (u) {
        await ensureProfileOrOnboard(u);
        return;
      }
    }

    // No choice yet or auth missing
    openEntryGateModal();
  }

  // -----------------------------
  // Account pill + menu
  // -----------------------------
  function getCircleColorFromProfile() {
    const c = authProfile?.circle_style?.color;
    return typeof c === "string" && c ? c : "var(--accent)";
  }

  function updateAccountPill() {
    const label = $("#accountName");
    const dot = $("#accountDot");
    if (!label || !dot) return;

    const mode = getUserMode();
    if (mode === "auth" && authUser) {
      label.textContent = authProfile?.display_name || "Account";
      dot.style.background = getCircleColorFromProfile();
      dot.style.opacity = "1";
      return;
    }

    label.textContent = "Anonymous";
    dot.style.background = "var(--accent)";
    dot.style.opacity = "0.7";
  }

  function openAccountMenu() {
    const mode = getUserMode();

    if (mode === "auth" && authUser) {
      const name = authProfile?.display_name || "Account";
      openModal({
        title: name,
        locked: false,
        body: `
          <p class="muted">Logged in. Your runs will be stored in your database.</p>
        `,
        actions: [
          { label: "Profile", variant: "ghost", onClick: () => openProfileModal(authUser) },
          {
            label: "Log out",
            variant: "ghost",
            onClick: async () => {
              closeModalForce();
              await signOut();
              openEntryGateModal();
            }
          },
          { label: "Close", variant: "primary", onClick: () => closeModal() }
        ]
      });
      return;
    }

    // Anonymous
    openModal({
      title: "Anonymous",
      locked: false,
      body: `<p class="muted">Simulated crowd. Everything stays on this device.</p>`,
      actions: [
        { label: "Log in / Register", variant: "primary", onClick: () => openAuthModal({ mode: "login" }) },
        { label: "Close", variant: "ghost", onClick: () => closeModal() }
      ]
    });
  }

  // -----------------------------
  // Challenge list (daily shared)
  // -----------------------------
  const DAILY_CHALLENGES = [
    { title: "Two-Minute Start", desc: "Do 2 minutes of the thing you’re avoiding. Stop after 2 minutes if you want. (You won’t.)" },
    { title: "Inbox Guillotine", desc: "Clear 10 emails/messages. Archive, delete, reply. No perfection, just motion." },
    { title: "Desk Reset", desc: "Make your workspace look like a person lives there. 5 items back where they belong." },
    { title: "One Ugly Draft", desc: "Create the worst first draft possible. Minimum 150 words / 10 lines. Pride stays outside." },
    { title: "Phone Exile", desc: "Put the phone away for 25 minutes. If you reach for it, you restart the timer in your head." },
    { title: "Micro-Workout", desc: "Do 30 squats or a 3-minute walk. Not fitness. Momentum." },
    { title: "File Graveyard", desc: "Delete or organize 20 files/screenshots. Your future self is watching." },
    { title: "The 1-Task List", desc: "Write exactly one task for today. Then do the first 5 minutes of it." },
    { title: "Noise Cut", desc: "Close 5 tabs/apps you don’t need. Yes, even that one. Especially that one." },
    { title: "Tomorrow Trap", desc: "Schedule one specific action for tomorrow (time + place). Then do 1 minute of prep now." },
    { title: "No-Zero Move", desc: "Do any non-zero progress: one paragraph, one slide, one commit, one call." },
    { title: "The Hard Part First", desc: "Do the hardest 5 minutes first. You don’t have to finish. You do have to start." }
  ];

  function getTodaysChallenge() {
    const seed = todaySeed("challenge");
    const rnd = mulberry32(seed);
    const idx = Math.floor(rnd() * DAILY_CHALLENGES.length);
    const c = DAILY_CHALLENGES[idx];
    return { ...c, id: idx };
  }

  // -----------------------------
  // Simulated crowd count (stable per UTC day)
  // -----------------------------
  function getTodaysCrowdNumber() {
    const seed = todaySeed("crowd");
    const rnd = mulberry32(seed);
    const base = 8000 + Math.floor(rnd() * 24000);
    const wiggle = Math.floor(rnd() * 1800);
    const n = base + wiggle;
    return n.toLocaleString();
  }

  // -----------------------------
  // Streak + daily rollover (UTC)
  // -----------------------------
  function getStreak() {
    const n = parseInt(localStorage.getItem(LS.streak) || "0", 10);
    return isFinite(n) ? n : 0;
  }
  function setStreak(n) {
    localStorage.setItem(LS.streak, String(Math.max(0, n)));
  }

  function getTodayChallengeState() {
    const dayKey = utcDayKey();
    const s = loadJSON(LS.todayState, null);
    if (!s || s.dayKey !== dayKey) {
      const fresh = {
        dayKey,
        state: "not_started", // not_started | in_progress | completed | failed
        startedAt: null,
        resultAt: null,
        challengeId: getTodaysChallenge().id
      };
      saveJSON(LS.todayState, fresh);
      return fresh;
    }
    return s;
  }
  function setTodayChallengeState(patch) {
    const cur = getTodayChallengeState();
    const next = { ...cur, ...patch };
    saveJSON(LS.todayState, next);
    return next;
  }

  function reconcileStreakForNewDay() {
    const today = utcDayKey();
    const last = localStorage.getItem(LS.lastStreakDay);
    if (!last) return;

    const lastDate = new Date(last + "T00:00:00Z");
    const todayDate = new Date(today + "T00:00:00Z");
    const diffDays = Math.floor((todayDate - lastDate) / (24 * 3600 * 1000));
    if (diffDays >= 2) {
      setStreak(0);
      toast("Streak", "Missed a day. Streak reset. Brutal, but fair.");
    }
  }

  // -----------------------------
  // Hub rendering
  // -----------------------------
  function stateLabel(s) {
    if (s === "not_started") return "Not started";
    if (s === "in_progress") return "In progress";
    if (s === "completed") return "Completed";
    if (s === "failed") return "Failed";
    return "Not started";
  }

  function renderHub() {
    const c = getTodaysChallenge();
    $("#miniChallengeName").textContent = `Today (UTC): ${c.title}`;

    const crowd = getTodaysCrowdNumber();
    $("#crowdNumber").textContent = `${crowd} people are in today`;

    const streak = getStreak();
    $("#streakBig").textContent = String(streak);
    $("#shareStreak1").textContent = String(streak);

    const st = getTodayChallengeState();
    const label = stateLabel(st.state);
    $("#todayStatusBig").textContent = label;
    $("#todayStatusSub").textContent =
      st.state === "not_started" ? "Pick a mode. Press “Join / Start”."
      : st.state === "in_progress" ? "Your run is active. Don’t leave."
      : st.state === "completed" ? "You did it. Again tomorrow?"
      : "Failed. Tomorrow exists.";

    const statusText = $("#statusText");
    const dot = $("#statusDot");
    statusText.textContent = `Today (UTC): ${label}`;
    dot.classList.remove("ok", "bad");
    if (st.state === "completed") dot.classList.add("ok");
    else if (st.state === "failed") dot.classList.add("bad");

    // share dates
    const dk = utcDayKey();
    $("#shareDate1").textContent = dk;
    $("#shareDate2").textContent = dk;
    $("#shareDate3").textContent = dk;

    updateAccountPill();
  }

  // -----------------------------
  // Shared anti-leave detector (15s away)
  // -----------------------------
  const Visibility = {
    activeRule: null // {type, thresholdMs, awayStart, onTrigger}
  };

  function startLeaveRule({ type, thresholdMs = 15000, onTrigger }) {
    Visibility.activeRule = {
      type,
      thresholdMs,
      awayStart: null,
      onTrigger
    };
  }

  function stopLeaveRule() {
    Visibility.activeRule = null;
  }

  function initVisibilityWatcher() {
    function checkBack() {
      const rule = Visibility.activeRule;
      if (!rule || !rule.awayStart) return;
      const awayMs = Date.now() - rule.awayStart;
      rule.awayStart = null;
      if (awayMs >= rule.thresholdMs) rule.onTrigger({ awayMs });
    }

    document.addEventListener("visibilitychange", () => {
      const rule = Visibility.activeRule;
      if (!rule) return;
      if (document.hidden) rule.awayStart = Date.now();
      else checkBack();
    });

    window.addEventListener("blur", () => {
      const rule = Visibility.activeRule;
      if (!rule) return;
      if (!rule.awayStart) rule.awayStart = Date.now();
    });

    window.addEventListener("focus", checkBack);
  }

  // -----------------------------
  // Mode 1: 24h Challenge
  // -----------------------------
  let resetTimer = null;

  function renderChallenge24() {
    const c = getTodaysChallenge();
    $("#challengeTitle").textContent = c.title;
    $("#challengeDesc").textContent = c.desc;
    $("#shareChallengeName").textContent = c.title;

    const st = getTodayChallengeState();
    $("#challengeStatusBig").textContent = stateLabel(st.state);
    $("#challengeStatusSub").textContent =
      st.state === "not_started" ? "Press “Join Challenge” to begin."
      : st.state === "in_progress" ? "Run active. Leave 15+ seconds → fail."
      : st.state === "completed" ? "Completed. Return tomorrow (UTC) for the next one."
      : "Failed. Return tomorrow. No excuses (but yes, rest).";

    $("#joinChallengeBtn").disabled = (st.state === "in_progress" || st.state === "completed");
    $("#completeChallengeBtn").disabled = (st.state !== "in_progress");
    $("#failChallengeBtn").disabled = (st.state !== "in_progress");

    const shareEnabled = (st.state === "completed" || st.state === "failed");
    $("#copyShare1").disabled = !shareEnabled;
    $("#downloadShare1").disabled = !shareEnabled;

    $("#shareResult1").textContent =
      st.state === "completed" ? "COMPLETED ✅" :
      st.state === "failed" ? "FAILED ❌" :
      "—";

    // countdown to next UTC midnight
    if (resetTimer) clearInterval(resetTimer);
    resetTimer = setInterval(() => {
      const ms = nextUtcMidnight().getTime() - Date.now();
      $("#resetCountdown").textContent = msToResetCountdown(ms);
      if (ms <= 0) {
        clearInterval(resetTimer);
        resetTimer = null;
        renderHub();
        renderChallenge24();
      }
    }, 250);
  }

  function joinChallenge() {
    const c = getTodaysChallenge();
    openModal({
      title: "Rule check",
      body: `
        <p><b>Leaving this tab for 15+ seconds will fail the run.</b></p>
        <p>Local-only in Anonymous. In Auth mode, the result is saved to DB.</p>
      `,
      actions: [
        { label: "Cancel", variant: "ghost", onClick: () => closeModal() },
        {
          label: "Join Challenge",
          variant: "primary",
          onClick: async () => {
            closeModal();

            setTodayChallengeState({
              state: "in_progress",
              startedAt: Date.now(),
              challengeId: c.id,
              resultAt: null
            });

            // DB
            await dbUpsertDailyRun({
              status: "in_progress",
              challengeId: c.id,
              startedAtISO: new Date().toISOString()
            });

            startLeaveRule({
              type: "challenge24",
              thresholdMs: 15000,
              onTrigger: ({ awayMs }) => {
                failChallenge(`Left for ${Math.floor(awayMs / 1000)}s (15s rule).`);
              }
            });

            toast("24h Challenge", "Run started. Don’t leave.");
            renderChallenge24();
            renderHub();
          }
        }
      ]
    });
  }

  function bumpText(el) {
    if (!el) return;
    el.style.transform = "translateY(-2px) scale(1.03)";
    el.style.transition = "transform .18s ease";
    setTimeout(() => {
      el.style.transform = "translateY(0) scale(1)";
    }, 180);
  }

  async function completeChallenge() {
    const st = getTodayChallengeState();
    if (st.state !== "in_progress") return;

    stopLeaveRule();

    const today = utcDayKey();
    const last = localStorage.getItem(LS.lastStreakDay);

    let streak = getStreak();
    if (last !== today) {
      if (last) {
        const lastDate = new Date(last + "T00:00:00Z");
        const todayDate = new Date(today + "T00:00:00Z");
        const diffDays = Math.floor((todayDate - lastDate) / (24 * 3600 * 1000));
        if (diffDays === 1) streak += 1;
        else streak = 1;
      } else {
        streak = 1;
      }
      setStreak(streak);
      localStorage.setItem(LS.lastStreakDay, today);
    }

    setTodayChallengeState({ state: "completed", resultAt: Date.now() });

    await dbUpsertDailyRun({
      status: "completed",
      challengeId: st.challengeId,
      startedAtISO: st.startedAt ? new Date(st.startedAt).toISOString() : null,
      endedAtISO: new Date().toISOString()
    });

    bumpText($("#streakBig"));
    bumpText($("#shareStreak1"));

    toast("Result", "COMPLETED ✅. See you tomorrow.");
    renderChallenge24();
    renderHub();
  }

  async function failChallenge(reason = "Failed.") {
    const st = getTodayChallengeState();
    if (st.state !== "in_progress") return;

    stopLeaveRule();
    setTodayChallengeState({ state: "failed", resultAt: Date.now() });

    await dbUpsertDailyRun({
      status: "failed",
      challengeId: st.challengeId,
      startedAtISO: st.startedAt ? new Date(st.startedAt).toISOString() : null,
      endedAtISO: new Date().toISOString(),
      failReason: reason
    });

    toast("Run failed", reason);

    renderChallenge24();
    renderHub();
  }

  // -----------------------------
  // Mode 2: Procrastination Boss Fight
  // -----------------------------
  const Boss = {
    running: false,
    totalMs: minutesToMs(25),
    remainingMs: minutesToMs(25),
    startISO: null,
    tick: null,
    selectedMin: 25,
    task: ""
  };

  function bossSetDuration(min) {
    Boss.selectedMin = min;
    Boss.totalMs = minutesToMs(min);
    Boss.remainingMs = minutesToMs(min);
    $("#bossTimer").textContent = msToClock(Boss.remainingMs);
    setBossHp(1);
  }

  function setBossHp(frac) {
    const f = clamp(frac, 0, 1);
    $("#bossHpFill").style.width = `${(f * 100).toFixed(2)}%`;
    $("#bossHpText").textContent = `${Math.round(f * 100)}%`;
  }

  function bossAttackFx() {
    const slash = $("#bossSlash");
    slash.classList.remove("on");
    void slash.offsetWidth;
    slash.classList.add("on");
  }

  function bossHealFx() {
    const heal = $("#bossHeal");
    const glow = $("#bossHpGlow");
    heal.classList.remove("on");
    glow.style.opacity = "1";
    void heal.offsetWidth;
    heal.classList.add("on");
    setTimeout(() => glow.style.opacity = "0", 240);
  }

  function updateBossUI() {
    $("#bossTimer").textContent = msToClock(Boss.remainingMs);
    setBossHp(Boss.remainingMs / Boss.totalMs);
  }

  function bossStart() {
    const task = ($("#bossTask").value || "").trim();
    if (!task) {
      toast("Boss Fight", "Name the task. It makes the fight real.");
      $("#bossTask").focus();
      return;
    }

    openModal({
      title: "Rule check",
      body: `
        <p><b>Leaving this tab for 15+ seconds makes the boss heal +20% HP.</b></p>
        <p>Anonymous = local-only. Auth = session stored in DB.</p>
      `,
      actions: [
        { label: "Cancel", variant: "ghost", onClick: () => closeModal() },
        {
          label: "Start Fight",
          variant: "primary",
          onClick: () => {
            closeModal();

            Boss.task = task;
            Boss.running = true;
            Boss.startISO = new Date().toISOString();

            $("#startBossBtn").disabled = true;
            $("#stopBossBtn").disabled = false;
            $("#bossState").textContent = `Fighting for: “${task}”. Keep the tab.`;

            startLeaveRule({
              type: "bossFight",
              thresholdMs: 15000,
              onTrigger: ({ awayMs }) => {
                const healMs = Math.floor(Boss.totalMs * 0.20);
                Boss.remainingMs = Math.min(Boss.totalMs, Boss.remainingMs + healMs);
                bossHealFx();
                toast("Boss healed", `Left for ${Math.floor(awayMs / 1000)}s. +20% HP.`);
                updateBossUI();
              }
            });

            Boss.tick = setInterval(() => {
              if (!Boss.running) return;
              Boss.remainingMs -= 1000;
              if (Boss.remainingMs < 0) Boss.remainingMs = 0;
              bossAttackFx();
              updateBossUI();
              if (Boss.remainingMs === 0) bossVictory();
            }, 1000);

            toast("Boss Fight", "Fight started. Deal damage by staying.");
          }
        }
      ]
    });
  }

  async function bossStop(reason = "Stopped.") {
    if (!Boss.running) return;

    Boss.running = false;
    clearInterval(Boss.tick);
    Boss.tick = null;
    stopLeaveRule();

    $("#startBossBtn").disabled = false;
    $("#stopBossBtn").disabled = true;
    $("#bossState").textContent = `Idle. ${reason}`;

    // DB: store stopped if they ended early
    if (Boss.remainingMs > 0) {
      await dbInsertSession({
        mode: "bossFight",
        taskName: Boss.task,
        durationMinutes: Boss.selectedMin,
        status: "stopped",
        startedAtISO: Boss.startISO,
        endedAtISO: new Date().toISOString()
      });
    }
  }

  async function bossVictory() {
    await bossStop("Victory.");

    toast("Victory", "Boss defeated. Procrastination took a hit.");

    // Save local history
    const list = loadJSON(LS.bossHistory, []);
    const entry = {
      dayKey: utcDayKey(),
      task: Boss.task,
      minutes: Boss.selectedMin,
      ts: Date.now()
    };
    list.unshift(entry);
    saveJSON(LS.bossHistory, list.slice(0, 20));

    // DB: store cleared (override: because bossStop may have inserted stopped)
    await dbInsertSession({
      mode: "bossFight",
      taskName: Boss.task,
      durationMinutes: Boss.selectedMin,
      status: "cleared",
      startedAtISO: Boss.startISO,
      endedAtISO: new Date().toISOString()
    });

    // Update share card
    $("#shareBossTask").textContent = Boss.task;
    $("#shareBossDur").textContent = `${Boss.selectedMin} min`;
    $("#copyShare2").disabled = false;
    $("#downloadShare2").disabled = false;

    renderBossHistory();
  }

  function renderBossHistory() {
    const list = loadJSON(LS.bossHistory, []);
    const root = $("#bossHistory");
    root.innerHTML = "";
    if (!list.length) {
      root.innerHTML = `<div class="muted">No fights recorded yet.</div>`;
      return;
    }
    list.slice(0, 10).forEach(e => {
      const div = document.createElement("div");
      div.className = "history-item";
      div.innerHTML = `
        <div class="history-top">
          <div class="history-title">${escapeHTML(e.task)}</div>
          <div class="mono">${escapeHTML(e.dayKey)}</div>
        </div>
        <div class="history-sub">${escapeHTML(`${e.minutes} min • Boss defeated`)}</div>
      `;
      root.appendChild(div);
    });
  }

  // -----------------------------
  // Mode 3: Focus Arena
  // -----------------------------
  const Arena = {
    running: false,
    totalMs: minutesToMs(25),
    remainingMs: minutesToMs(25),
    tick: null,
    selectedMin: 25,
    people: 0,
    startISO: null
  };

  function arenaSetDuration(min) {
    Arena.selectedMin = min;
    Arena.totalMs = minutesToMs(min);
    Arena.remainingMs = minutesToMs(min);
    $("#arenaTimer").textContent = msToClock(Arena.remainingMs);
    renderArenaPeople();
  }

  function renderArenaPeople() {
    const seed = todaySeed(`arena:${Arena.selectedMin}`);
    const rnd = mulberry32(seed);
    const base = 300 + Math.floor(rnd() * 1600);
    const wave = Math.floor(rnd() * 220);
    Arena.people = base + wave;
    $("#arenaPeople").textContent = `${Arena.people.toLocaleString()} focusing right now`;
  }

  function getArenaBadges() {
    const n = parseInt(localStorage.getItem(LS.arenaBadges) || "0", 10);
    return isFinite(n) ? n : 0;
  }
  function setArenaBadges(n) {
    localStorage.setItem(LS.arenaBadges, String(Math.max(0, n)));
  }

  function renderArenaBadges() {
    const b = getArenaBadges();
    const mod = b % 3;
    $("#badgeText").textContent = `${mod} / 3`;
    $("#badgeFill").style.width = `${(mod / 3) * 100}%`;
  }

  function arenaStart() {
    openModal({
      title: "Rule check",
      body: `
        <p><b>Leaving this tab for 15+ seconds fails the session.</b></p>
        <p>Anonymous = local-only. Auth = session stored in DB.</p>
      `,
      actions: [
        { label: "Cancel", variant: "ghost", onClick: () => closeModal() },
        {
          label: "Enter Arena",
          variant: "primary",
          onClick: () => {
            closeModal();

            Arena.running = true;
            Arena.startISO = new Date().toISOString();

            $("#startArenaBtn").disabled = true;
            $("#stopArenaBtn").disabled = false;
            $("#arenaState").textContent = "Session active. Stay. Breathe. Do.";

            startLeaveRule({
              type: "focusArena",
              thresholdMs: 15000,
              onTrigger: ({ awayMs }) => {
                arenaFail(`Left for ${Math.floor(awayMs / 1000)}s (15s rule).`);
              }
            });

            Arena.tick = setInterval(() => {
              if (!Arena.running) return;
              Arena.remainingMs -= 1000;
              if (Arena.remainingMs < 0) Arena.remainingMs = 0;

              $("#arenaTimer").textContent = msToClock(Arena.remainingMs);
              if (Arena.remainingMs === 0) arenaVictory();
            }, 1000);

            toast("Focus Arena", "Session started. Quiet pressure engaged.");
          }
        }
      ]
    });
  }

  async function arenaStop(reason = "Stopped.") {
    if (!Arena.running) return;

    Arena.running = false;
    clearInterval(Arena.tick);
    Arena.tick = null;
    stopLeaveRule();

    $("#startArenaBtn").disabled = false;
    $("#stopArenaBtn").disabled = true;
    $("#arenaState").textContent = `Idle. ${reason}`;

    // DB: stopped
    if (Arena.remainingMs > 0) {
      await dbInsertSession({
        mode: "focusArena",
        durationMinutes: Arena.selectedMin,
        status: "stopped",
        startedAtISO: Arena.startISO,
        endedAtISO: new Date().toISOString()
      });
    }
  }

  async function arenaVictory() {
    await arenaStop("Session cleared.");

    toast("Session cleared", "Clean win. The arena approves.");

    // badges
    const b = getArenaBadges() + 1;
    setArenaBadges(b);
    renderArenaBadges();

    if (b % 3 === 0) toast("Badge", "Badge earned. Tiny reward, big ego.");

    // local history
    const list = loadJSON(LS.arenaHistory, []);
    const entry = { dayKey: utcDayKey(), minutes: Arena.selectedMin, ts: Date.now(), result: "cleared" };
    list.unshift(entry);
    saveJSON(LS.arenaHistory, list.slice(0, 30));

    // DB: cleared
    await dbInsertSession({
      mode: "focusArena",
      durationMinutes: Arena.selectedMin,
      status: "cleared",
      startedAtISO: Arena.startISO,
      endedAtISO: new Date().toISOString()
    });

    $("#shareArenaResult").textContent = "CLEARED ✅";
    $("#shareArenaDur").textContent = `${Arena.selectedMin} min`;
    $("#shareArenaBadges").textContent = `${(b % 3)} / 3`;
    $("#copyShare3").disabled = false;
    $("#downloadShare3").disabled = false;

    renderArenaHistory();
  }

  async function arenaFail(reason = "Failed.") {
    if (!Arena.running) return;

    await arenaStop("Failed.");
    toast("Session failed", reason);

    // local history
    const list = loadJSON(LS.arenaHistory, []);
    const entry = { dayKey: utcDayKey(), minutes: Arena.selectedMin, ts: Date.now(), result: "failed" };
    list.unshift(entry);
    saveJSON(LS.arenaHistory, list.slice(0, 30));

    // DB: failed
    await dbInsertSession({
      mode: "focusArena",
      durationMinutes: Arena.selectedMin,
      status: "failed",
      startedAtISO: Arena.startISO,
      endedAtISO: new Date().toISOString()
    });

    $("#shareArenaResult").textContent = "FAILED ❌";
    $("#shareArenaDur").textContent = `${Arena.selectedMin} min`;
    $("#shareArenaBadges").textContent = `${(getArenaBadges() % 3)} / 3`;
    $("#copyShare3").disabled = false;
    $("#downloadShare3").disabled = false;

    renderArenaHistory();
  }

  function renderArenaHistory() {
    const list = loadJSON(LS.arenaHistory, []);
    const root = $("#arenaHistory");
    root.innerHTML = "";
    if (!list.length) {
      root.innerHTML = `<div class="muted">No arena sessions recorded yet.</div>`;
      return;
    }
    list.slice(0, 10).forEach(e => {
      const div = document.createElement("div");
      div.className = "history-item";
      const res = e.result === "cleared" ? "Cleared ✅" : "Failed ❌";
      div.innerHTML = `
        <div class="history-top">
          <div class="history-title">${escapeHTML(`${e.minutes} min`)}</div>
          <div class="mono">${escapeHTML(e.dayKey)}</div>
        </div>
        <div class="history-sub">${escapeHTML(res)}</div>
      `;
      root.appendChild(div);
    });
  }

  // -----------------------------
  // Share text + share image
  // -----------------------------
  function buildShareText({ date, title, result, streak, extraLines = [] }) {
    const lines = [
      `You vs Everyone — Day ${date}`,
      `Challenge: ${title}`,
      `Result: ${result}`,
    ];
    if (typeof streak === "number") lines.push(`Streak: ${streak}`);
    extraLines.forEach(l => lines.push(l));
    return lines.join("\n");
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied", "Share text copied to clipboard.");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); toast("Copied", "Share text copied (fallback)."); }
      catch { toast("Copy failed", "Your browser blocked clipboard."); }
      ta.remove();
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 100);
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawShareCard({ title, subtitle, lines, footer }) {
    const theme = document.documentElement.getAttribute("data-theme") || "dark";
    const W = 1200, H = 630;

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = theme === "light" ? "#f6f7fb" : "#0b0c10";
    ctx.fillRect(0, 0, W, H);

    const g1 = ctx.createRadialGradient(260, 140, 40, 260, 140, 520);
    g1.addColorStop(0, theme === "light" ? "rgba(31,143,255,0.18)" : "rgba(141,217,255,0.18)");
    g1.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g1; ctx.fillRect(0, 0, W, H);

    const g2 = ctx.createRadialGradient(980, 520, 60, 980, 520, 560);
    g2.addColorStop(0, theme === "light" ? "rgba(18,182,107,0.14)" : "rgba(178,255,204,0.14)");
    g2.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);

    const r = 34;
    roundRect(ctx, 70, 70, W - 140, H - 140, r);
    ctx.fillStyle = theme === "light" ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.06)";
    ctx.fill();
    ctx.strokeStyle = theme === "light" ? "rgba(10,12,16,0.10)" : "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = theme === "light" ? "rgba(10,12,16,0.92)" : "rgba(255,255,255,0.92)";
    ctx.font = "800 54px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.fillText("You vs Everyone", 120, 170);

    ctx.fillStyle = theme === "light" ? "rgba(10,12,16,0.62)" : "rgba(255,255,255,0.62)";
    ctx.font = "600 26px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.fillText(subtitle, 120, 215);

    ctx.strokeStyle = theme === "light" ? "rgba(10,12,16,0.10)" : "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(120, 250);
    ctx.lineTo(W - 120, 250);
    ctx.stroke();

    ctx.fillStyle = theme === "light" ? "rgba(10,12,16,0.92)" : "rgba(255,255,255,0.92)";
    ctx.font = "800 40px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.fillText(title, 120, 320);

    ctx.fillStyle = theme === "light" ? "rgba(10,12,16,0.70)" : "rgba(255,255,255,0.70)";
    ctx.font = "650 28px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    let y = 370;
    lines.forEach((ln) => {
      ctx.fillText(ln, 120, y);
      y += 44;
    });

    ctx.fillStyle = theme === "light" ? "rgba(10,12,16,0.45)" : "rgba(255,255,255,0.45)";
    ctx.font = "650 22px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace";
    ctx.fillText(footer, 120, H - 130);

    return canvas;
  }

  // -----------------------------
  // Crowd + Arena visuals
  // -----------------------------
  function initCrowdCanvas() {
    const canvas = $("#crowdCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const seed = todaySeed("crowdParticles");
    const rnd = mulberry32(seed);

    const W = canvas.width, H = canvas.height;
    const N = 90;

    const dots = Array.from({ length: N }, () => ({
      x: rnd() * W,
      y: rnd() * H,
      r: 2 + rnd() * 3,
      vx: (rnd() - 0.5) * 0.22,
      vy: (rnd() - 0.5) * 0.22,
      p: rnd() * Math.PI * 2
    }));

    function frame() {
      const theme = document.documentElement.getAttribute("data-theme") || "dark";
      ctx.clearRect(0, 0, W, H);

      for (const d of dots) {
        d.p += 0.02;
        d.x += d.vx;
        d.y += d.vy + Math.sin(d.p) * 0.05;

        if (d.x < -10) d.x = W + 10;
        if (d.x > W + 10) d.x = -10;
        if (d.y < -10) d.y = H + 10;
        if (d.y > H + 10) d.y = -10;

        const alpha = 0.45 + 0.25 * Math.sin(d.p);
        ctx.beginPath();
        ctx.fillStyle = theme === "light"
          ? `rgba(31,143,255,${alpha})`
          : `rgba(141,217,255,${alpha})`;
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }

      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.5, theme === "light" ? "rgba(18,182,107,0.08)" : "rgba(178,255,204,0.08)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, H * 0.52, W, 80);

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  function initArenaCanvas() {
    const canvas = $("#arenaCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;

    let t = 0;
    const baseSeed = todaySeed("arenaViz");
    const rnd = mulberry32(baseSeed);

    const rings = Array.from({ length: 5 }, (_, i) => ({
      cx: W * (0.25 + rnd() * 0.5),
      cy: H * (0.25 + rnd() * 0.5),
      r0: 22 + i * 18
    }));

    const dots = Array.from({ length: 64 }, () => ({
      x: rnd() * W,
      y: rnd() * H,
      r: 2 + rnd() * 2,
      phase: rnd() * Math.PI * 2
    }));

    function frame() {
      const theme = document.documentElement.getAttribute("data-theme") || "dark";
      ctx.clearRect(0, 0, W, H);

      t += 0.016;

      rings.forEach((rg, i) => {
        const pr = rg.r0 + 18 * (0.5 + 0.5 * Math.sin(t * (1 + i * 0.12)));
        ctx.beginPath();
        ctx.strokeStyle = theme === "light"
          ? `rgba(31,143,255,${0.10 + i * 0.02})`
          : `rgba(141,217,255,${0.10 + i * 0.02})`;
        ctx.lineWidth = 2;
        ctx.arc(rg.cx, rg.cy, pr, 0, Math.PI * 2);
        ctx.stroke();
      });

      dots.forEach((d) => {
        const pulse = 0.45 + 0.45 * Math.sin(t * 2 + d.phase);
        const alpha = Arena.running ? 0.16 + 0.22 * pulse : 0.10 + 0.12 * pulse;
        ctx.beginPath();
        ctx.fillStyle = theme === "light"
          ? `rgba(18,182,107,${alpha})`
          : `rgba(178,255,204,${alpha})`;
        ctx.arc(d.x, d.y, d.r + (Arena.running ? pulse * 0.9 : pulse * 0.3), 0, Math.PI * 2);
        ctx.fill();
      });

      const g = ctx.createRadialGradient(W / 2, H * 1.1, 20, W / 2, H * 1.1, H * 0.9);
      g.addColorStop(0, theme === "light" ? "rgba(10,12,16,0.08)" : "rgba(255,255,255,0.06)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  // -----------------------------
  // Navigation wiring
  // -----------------------------
  function initNav() {
    $$('[data-action="enterMode"]').forEach(btn => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-mode");
        if (mode === "challenge24") {
          showScreen("#screenChallenge24");
          renderChallenge24();
        } else if (mode === "bossFight") {
          showScreen("#screenBossFight");
          renderBossHistory();
          updateBossUI();
          $("#copyShare2").disabled = true;
          $("#downloadShare2").disabled = true;
          $("#shareBossTask").textContent = "—";
          $("#shareBossDur").textContent = "—";
        } else if (mode === "focusArena") {
          showScreen("#screenFocusArena");
          renderArenaPeople();
          renderArenaBadges();
          renderArenaHistory();
          $("#copyShare3").disabled = true;
          $("#downloadShare3").disabled = true;
          $("#shareArenaResult").textContent = "—";
          $("#shareArenaDur").textContent = "—";
          $("#shareArenaBadges").textContent = "—";
        }
      });
    });

    $$('[data-action="backHome"]').forEach(btn => {
      btn.addEventListener("click", async () => {
        if (Boss.running) await bossStop("Paused (left the fight).");
        if (Arena.running) await arenaStop("Paused (left the arena).");
        showScreen("#screenHome");
        renderHub();
      });
    });

    $("#goHome").addEventListener("click", async () => {
      if (Boss.running) await bossStop("Paused (left the fight).");
      if (Arena.running) await arenaStop("Paused (left the arena).");
      showScreen("#screenHome");
      renderHub();
    });

    $("#goHome").addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        $("#goHome").click();
      }
    });
  }

  // -----------------------------
  // Wire up buttons + inputs
  // -----------------------------
  function initActions() {
    // Account pill
    const accountPill = $("#accountPill");
    if (accountPill) accountPill.addEventListener("click", openAccountMenu);

    // 24h challenge
    $("#joinChallengeBtn").addEventListener("click", joinChallenge);
    $("#completeChallengeBtn").addEventListener("click", completeChallenge);
    $("#failChallengeBtn").addEventListener("click", () => failChallenge("Manual fail. Honest."));

    $("#copyShare1").addEventListener("click", () => {
      const st = getTodayChallengeState();
      const c = getTodaysChallenge();
      const date = utcDayKey();
      const streak = getStreak();
      const result = st.state === "completed" ? "COMPLETED ✅" : st.state === "failed" ? "FAILED ❌" : "—";
      const text = buildShareText({ date, title: c.title, result, streak });
      copyToClipboard(text);
    });

    $("#downloadShare1").addEventListener("click", () => {
      const st = getTodayChallengeState();
      const c = getTodaysChallenge();
      const date = utcDayKey();
      const streak = getStreak();
      const result = st.state === "completed" ? "COMPLETED ✅" : st.state === "failed" ? "FAILED ❌" : "—";

      const canvas = drawShareCard({
        title: c.title,
        subtitle: `Day ${date} • 24h Challenge (UTC)`,
        lines: [`Result: ${result}`, `Streak: ${streak}`],
        footer: "Simulated crowd • Local-only (anon) • No tracking"
      });

      canvas.toBlob((blob) => {
        if (!blob) return toast("Download failed", "Canvas export failed.");
        downloadBlob(blob, `yve_${date}_challenge.png`);
      }, "image/png", 0.92);
    });

    // Boss presets
    $$("#screenBossFight .seg-btn[data-min]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (Boss.running) return toast("Boss Fight", "Finish or stop the fight to change duration.");
        $$("#screenBossFight .seg-btn[data-min]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        bossSetDuration(parseInt(btn.getAttribute("data-min"), 10));
      });
    });

    $("#startBossBtn").addEventListener("click", bossStart);
    $("#stopBossBtn").addEventListener("click", () => bossStop("Stopped. The boss smirks."));

    $("#copyShare2").addEventListener("click", () => {
      const date = utcDayKey();
      const task = $("#shareBossTask").textContent.trim();
      const dur = $("#shareBossDur").textContent.trim();
      const text = [
        `You vs Everyone — Day ${date}`,
        `Boss Fight: Procrastination defeated ✅`,
        `Task: ${task}`,
        `Duration: ${dur}`
      ].join("\n");
      copyToClipboard(text);
    });

    $("#downloadShare2").addEventListener("click", () => {
      const date = utcDayKey();
      const task = $("#shareBossTask").textContent.trim();
      const dur = $("#shareBossDur").textContent.trim();

      const canvas = drawShareCard({
        title: "Boss Defeated",
        subtitle: `Day ${date} • Procrastination Boss Fight`,
        lines: [`Task: ${task}`, `Duration: ${dur}`],
        footer: "Local-only (anon) • No tracking"
      });

      canvas.toBlob((blob) => {
        if (!blob) return toast("Download failed", "Canvas export failed.");
        downloadBlob(blob, `yve_${date}_bossfight.png`);
      }, "image/png", 0.92);
    });

    // Focus presets
    $$("#screenFocusArena .seg-btn[data-focus-min]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (Arena.running) return toast("Focus Arena", "Finish or stop the session to change duration.");
        $$("#screenFocusArena .seg-btn[data-focus-min]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        arenaSetDuration(parseInt(btn.getAttribute("data-focus-min"), 10));
      });
    });

    $("#startArenaBtn").addEventListener("click", arenaStart);
    $("#stopArenaBtn").addEventListener("click", () => arenaStop("Stopped. The arena stays silent."));

    $("#copyShare3").addEventListener("click", () => {
      const date = utcDayKey();
      const res = $("#shareArenaResult").textContent.trim();
      const dur = $("#shareArenaDur").textContent.trim();
      const badges = $("#shareArenaBadges").textContent.trim();
      const text = [
        `You vs Everyone — Day ${date}`,
        `Focus Arena`,
        `Result: ${res}`,
        `Session: ${dur}`,
        `Badges: ${badges}`
      ].join("\n");
      copyToClipboard(text);
    });

    $("#downloadShare3").addEventListener("click", () => {
      const date = utcDayKey();
      const res = $("#shareArenaResult").textContent.trim();
      const dur = $("#shareArenaDur").textContent.trim();
      const badges = $("#shareArenaBadges").textContent.trim();

      const canvas = drawShareCard({
        title: "Focus Arena",
        subtitle: `Day ${date} • Silent session`,
        lines: [`Result: ${res}`, `Session: ${dur}`, `Badges: ${badges}`],
        footer: "Simulated presence • Local-only (anon)"
      });

      canvas.toBlob((blob) => {
        if (!blob) return toast("Download failed", "Canvas export failed.");
        downloadBlob(blob, `yve_${date}_arena.png`);
      }, "image/png", 0.92);
    });

    // Escape close
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modalBackdrop.hidden) closeModal();
    });
  }

  // -----------------------------
  // Defaults
  // -----------------------------
  function initDefaults() {
    bossSetDuration(25);
    arenaSetDuration(25);

    $("#shareBossTask").textContent = "—";
    $("#shareBossDur").textContent = "—";
    $("#shareArenaResult").textContent = "—";
    $("#shareArenaDur").textContent = "—";
    $("#shareArenaBadges").textContent = "—";
  }

  // -----------------------------
  // Boot
  // -----------------------------
  async function boot() {
    initTheme();
    initSupabase();

    reconcileStreakForNewDay();

    initVisibilityWatcher();
    initNav();
    initActions();
    initDefaults();

    renderHub();
    initCrowdCanvas();
    initArenaCanvas();
    renderArenaBadges();

    showScreen("#screenHome");

    await ensureEntryGate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { boot(); });
  } else {
    boot();
  }

})();
