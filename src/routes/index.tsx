import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { searchYouTube, type VideoResult } from "@/lib/youtube-search.functions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Heart, Settings2, Volume1, Volume2, Gauge, Minus } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Midi YouTube for Musicians" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "description", content: "Control YouTube playback with any USB MIDI controller: play, cue points, seek, volume and speed." },
      { property: "og:title", content: "Midi YouTube for Musicians" },
      { property: "og:description", content: "Practice with YouTube hands-free using your MIDI controller." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [
      { rel: "icon", href: "/app-icon.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/app-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  component: App,
});

/* ---------- types & storage ---------- */
type ActionId =
  | "playPause" | "goto"
  | "forward" | "back" | "volUp" | "volDown" | "speedUp" | "speedDown";

const ACTIONS: { id: ActionId; label: string }[] = [
  { id: "playPause", label: "Play / Pause" },
  { id: "goto", label: "Go to" },
  { id: "forward", label: "Forward" },
  { id: "back", label: "Back" },
  { id: "volUp", label: "Volume +10%" },
  { id: "volDown", label: "Volume −10%" },
  { id: "speedUp", label: "Speed +25%" },
  { id: "speedDown", label: "Speed −25%" },
];

type Settings = {
  mappings: Partial<Record<ActionId, string>>;
  cues: { goto: { m: number; s: number } };
  seekStep: number;
  volume: number;
  speed: number;
  autoFullscreen: boolean;
};
type Favorite = { id: string; title: string; goto: { m: number; s: number } };
type Saved = {
  settings: Settings;
  lastQuery: string;
  lastResults: VideoResult[];
  lastVideo: { id: string; title: string; time: number } | null;
  favorites: Favorite[];
};
const KEY = "midi-yt-musicians-v1";
const DEFAULTS: Saved = {
  settings: {
    mappings: {},
    cues: { goto: { m: 0, s: 0 } },
    seekStep: 5,
    volume: 80,
    speed: 1,
    autoFullscreen: true,
  },
  lastQuery: "",
  lastResults: [],
  lastVideo: { id: "tEtukfFv3Wk", title: "How To Play Piano (Beginner Piano Lesson)", time: 0 },
  favorites: [],
};
function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw);
    const settings: Settings = { ...DEFAULTS.settings, ...p.settings };
    // migrate: old multi-cue "Go to" (goto1..goto4) -> single "goto"
    const cues = { ...(p.settings?.cues ?? {}) } as Record<string, { m: number; s: number } | undefined>;
    for (const old of ["goto1", "goto2", "goto3", "goto4"]) {
      if (cues[old]) { cues["goto"] = cues[old]; delete cues[old]; }
    }
    if (!cues["goto"]) cues["goto"] = { m: 0, s: 0 };
    settings.cues = cues as Settings["cues"];
    const maps = { ...(p.settings?.mappings ?? {}) } as Record<string, string | undefined>;
    for (const old of ["goto1", "goto2", "goto3", "goto4"]) {
      if (maps[old]) { maps["goto"] = maps[old]; delete maps[old]; }
    }
    settings.mappings = maps as Settings["mappings"];
    return { ...DEFAULTS, ...p, settings, favorites: Array.isArray(p.favorites) ? p.favorites : [] };
  } catch {
    return DEFAULTS;
  }
}

const fmt = (t: number) => {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
};

declare global {
  interface Window { YT: any; onYouTubeIframeAPIReady?: () => void }
}

function loadYT(): Promise<any> {
  if (!document.getElementById("yt-api")) {
    const sc = document.createElement("script");
    sc.id = "yt-api";
    sc.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(sc);
  }
  return new Promise((resolve) => {
    const check = () => (window.YT?.Player ? resolve(window.YT) : setTimeout(check, 100));
    check();
  });
}

/* ---------- App ---------- */
function App() {
  const [ready, setReady] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [state, setState] = useState<Saved>(DEFAULTS);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => { setState(load()); setReady(true); }, []);
  useEffect(() => { if (ready) localStorage.setItem(KEY, JSON.stringify(state)); }, [state, ready]);

  const setSettings = (fn: (s: Settings) => Settings) =>
    setState((p) => ({ ...p, settings: fn(p.settings) }));

  const setGoto = (goto: { m: number; s: number }) => {
    setState((p) => {
      const lastVideoId = p.lastVideo?.id;
      return {
        ...p,
        settings: { ...p.settings, cues: { ...p.settings.cues, goto } },
        favorites: lastVideoId
          ? p.favorites.map((f) => f.id === lastVideoId ? { ...f, goto: { ...goto } } : f)
          : p.favorites,
      };
    });
  };

  /* player */
  const playerRef = useRef<any>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [stageWidth, setStageWidth] = useState(0);
  const [overlay, setOverlay] = useState<{ text: string; key: number } | null>(null);
  const [actionButtonFlash, setActionButtonFlash] = useState<"volUp" | "volDown" | "speedUp" | "speedDown" | null>(null);
  const actionButtonTimer = useRef<number | undefined>(undefined);
  const overlayTimer = useRef<number | undefined>(undefined);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStageWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(controlsTimer.current);
    controlsTimer.current = window.setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  useEffect(() => {
    showControls();
    return () => window.clearTimeout(controlsTimer.current);
  }, [showControls]);

  const flash = useCallback((text: string) => {
    setOverlay({ text, key: Date.now() });
    window.clearTimeout(overlayTimer.current);
    overlayTimer.current = window.setTimeout(() => setOverlay(null), 2000);
  }, []);

  const flashActionButton = useCallback((id: "volUp" | "volDown" | "speedUp" | "speedDown") => {
    setActionButtonFlash(id);
    window.clearTimeout(actionButtonTimer.current);
    actionButtonTimer.current = window.setTimeout(() => setActionButtonFlash(null), 450);
  }, []);

  useEffect(() => () => window.clearTimeout(actionButtonTimer.current), []);

  const killCaptions = () => {
    const p = playerRef.current;
    try { p?.unloadModule?.("captions"); p?.unloadModule?.("cc"); p?.setOption?.("captions", "track", {}); } catch {}
  };

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    loadYT().then((YT) => {
      if (cancelled || !hostRef.current) return;
      hostRef.current.innerHTML = "";
      const el = document.createElement("div");
      hostRef.current.appendChild(el);
      const lv = stateRef.current.lastVideo;
      playerRef.current = new YT.Player(el, {
        width: "100%", height: "100%",
        ...(lv ? { videoId: lv.id } : {}),
        playerVars: {
          controls: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, disablekb: 1,
          fs: 0, playsinline: 1, cc_load_policy: 0, autoplay: 1, origin: window.location.origin,
          start: lv ? Math.floor(lv.time) : 0,
        },
        events: {
          onReady: (e: any) => {
            const s = stateRef.current.settings;
            e.target.setVolume(s.volume);
            e.target.setPlaybackRate(s.speed);
            killCaptions();
            if (lv) e.target.playVideo();
          },
          onStateChange: (e: any) => {
            setPlaying(e.data === 1);
            if (e.data === 1) { killCaptions(); e.target.setPlaybackRate(stateRef.current.settings.speed); }
          },
          onApiChange: killCaptions,
        },
      });
    });
    return () => { cancelled = true; try { playerRef.current?.destroy?.(); } catch {} playerRef.current = null; };
  }, [ready]);

  // poll progress; save position; stop before end-screen suggestions
  useEffect(() => {
    const iv = window.setInterval(() => {
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;
      const t = p.getCurrentTime(), d = p.getDuration();
      setDuration(d);
      // Keep the knob at the user's chosen position while YouTube catches up.
      if (seekVisualRef.current !== null) {
        const target = seekVisualRef.current;
        if (Math.abs(t - target) < 1.5) seekVisualRef.current = null;
        else setTime(target);
      } else {
        setTime(t);
      }
      if (d > 0 && t > d - 0.4 && p.getPlayerState() === 1) { p.pauseVideo(); p.seekTo(d - 0.5, true); }
    }, 250);
    const sv = window.setInterval(() => {
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;
      setState((s) => (s.lastVideo ? { ...s, lastVideo: { ...s.lastVideo, time: p.getCurrentTime() } } : s));
    }, 3000);
    return () => { clearInterval(iv); clearInterval(sv); };
  }, []);

  const playVideo = (v: VideoResult, startSeconds = 0) => {
    setState((s) => ({ ...s, lastVideo: { id: v.id, title: v.title, time: startSeconds } }));
    playerRef.current?.loadVideoById?.({ videoId: v.id, startSeconds });
  };

  const toggleFavorite = () => {
    const video = stateRef.current.lastVideo;
    if (!video) return;
    const c = stateRef.current.settings.cues.goto ?? { m: 0, s: 0 };
    const favorite: Favorite = { id: video.id, title: video.title, goto: { m: c.m, s: c.s } };
    const exists = stateRef.current.favorites.some((f) => f.id === video.id);
    setState((s) => ({ ...s, favorites: exists ? s.favorites.filter((f) => f.id !== video.id) : [favorite, ...s.favorites] }));
    flash(exists ? "♡  Removed from favorites" : "♥  Added to favorites");
  };

  const openFavorite = (f: Favorite) => {
    const start = f.goto.m * 60 + f.goto.s;
    setState((s) => ({ ...s, lastVideo: { id: f.id, title: f.title, time: start } }));
    playerRef.current?.loadVideoById?.({ videoId: f.id, startSeconds: start });
    setSettingsOpen(false);
  };

  /* actions */
  const runAction = useCallback((id: ActionId) => {
    const p = playerRef.current;
    if (!p?.getPlayerState) return;
    const s = stateRef.current.settings;
    const t = p.getCurrentTime();
    switch (id) {
      case "playPause":
        if (p.getPlayerState() === 1) { p.pauseVideo(); flash("❚❚  Pause"); }
        else { p.playVideo(); flash("▶  Play"); }
        break;
      case "goto": {
        const c = s.cues.goto ?? { m: 0, s: 0 }; const target = c.m * 60 + c.s;
        p.seekTo(target, true);
        p.playVideo();
        flash(`⤓  Go to ${fmt(target)}`); break;
      }
      case "forward": p.seekTo(Math.min(t + s.seekStep, p.getDuration()), true); flash(`»  +${s.seekStep}s`); break;
      case "back": p.seekTo(Math.max(t - s.seekStep, 0), true); flash(`«  −${s.seekStep}s`); break;
      case "volUp": case "volDown": {
        const v = Math.max(0, Math.min(100, s.volume + (id === "volUp" ? 10 : -10)));
        p.setVolume(v); if (v > 0) p.unMute();
        setSettings((x) => ({ ...x, volume: v })); flashActionButton(id); flash(`🔊  Volume ${v}%`); break;
      }
      case "speedUp": case "speedDown": {
        const r = Math.max(0.25, Math.min(2, s.speed + (id === "speedUp" ? 0.25 : -0.25)));
        p.setPlaybackRate(r); setSettings((x) => ({ ...x, speed: r })); flashActionButton(id); flash(`⏱  Speed ${r}x`); break;
      }
    }
  }, [flash, flashActionButton]);

  /* MIDI */
  const [midiStatus, setMidiStatus] = useState("Connecting…");
  const [devices, setDevices] = useState<string[]>([]);
  const [learning, setLearning] = useState<ActionId | null>(null);
  const learningRef = useRef(learning);
  learningRef.current = learning;
  const [lastMsg, setLastMsg] = useState("");

  const midiAccessRef = useRef<any>(null);

  const connectMidi = useCallback(async () => {
    const nav = navigator as any;
    if (!nav.requestMIDIAccess) {
      setMidiStatus("Web MIDI not supported in this browser (use Chrome or Edge)");
      return;
    }

    try {
      const access = await nav.requestMIDIAccess();
      midiAccessRef.current = access;

      const onMsg = (e: any) => {
        const [st = 0, d1 = 0, d2 = 0] = e.data as Uint8Array;
        const type = st & 0xf0, ch = (st & 0x0f) + 1;
        let key: string | null = null;
        if (type === 0x90 && d2 > 0) key = `note:${ch}:${d1}`;
        else if (type === 0xb0 && d2 > 0) key = `cc:${ch}:${d1}`;
        else if (type === 0xc0) key = `pc:${ch}:${d1}`;
        if (!key) return;
        setLastMsg(key.replace(/:/, " ch").replace(/:/, " #"));
        const l = learningRef.current;
        if (l) {
          setSettings((s) => {
            const m = { ...s.mappings };
            for (const k in m) if (m[k as ActionId] === key) delete m[k as ActionId];
            m[l] = key!;
            return { ...s, mappings: m };
          });
          setLearning(null);
          flash(`Learned: ${ACTIONS.find((a) => a.id === l)?.label}`);
          return;
        }
        const maps = stateRef.current.settings.mappings;
        const act = (Object.keys(maps) as ActionId[]).find((k) => maps[k] === key);
        if (act) runAction(act);
      };

      const bind = () => {
        const names: string[] = [];
        access.inputs.forEach((i: any) => { i.onmidimessage = onMsg; names.push(i.name); });
        setDevices(names);
        setMidiStatus(names.length ? "Connected" : "No MIDI device found – plug in a controller");
      };

      bind();
      access.onstatechange = bind;
    } catch {
      setMidiStatus("MIDI access denied");
    }
  }, [runAction, flash]);

  useEffect(() => {
    if (!ready) return;
    connectMidi();
    return () => {
      midiAccessRef.current?.inputs.forEach((i: any) => (i.onmidimessage = null));
    };
  }, [ready, connectMidi]);

  /* fullscreen */
  const [isFs, setIsFs] = useState(false);
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stageRef.current?.requestFullscreen?.().catch(() => {});
  };
  useEffect(() => {
    const h = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);
  useEffect(() => {
    if (!ready || !state.settings.autoFullscreen) return;
    const external = (window.screen as any).isExtended || /DeX/i.test(navigator.userAgent) ||
      (window.screen.width >= 1600 && matchMedia("(pointer: fine)").matches);
    if (!external) return;
    const go = () => { if (!document.fullscreenElement) stageRef.current?.requestFullscreen?.().catch(() => {}); };
    go(); // browsers may require a first click/key; fall back below
    const once = () => { go(); cleanup(); };
    const cleanup = () => { window.removeEventListener("pointerdown", once); window.removeEventListener("keydown", once); };
    window.addEventListener("pointerdown", once); window.addEventListener("keydown", once);
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /* search */
  const [query, setQuery] = useState("");
  useEffect(() => { if (ready) setQuery(state.lastQuery); /* eslint-disable-next-line */ }, [ready]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const doSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim(); if (!q) return;
    setSearching(true);
    try {
      const { results } = await searchYouTube({ data: { q } });
      setState((s) => ({ ...s, lastQuery: q, lastResults: results }));
    } finally { setSearching(false); }
  };
  const pick = (v: VideoResult) => {
    setSelected(v.id);
    setTimeout(() => setSelected(null), 1200);
    playVideo(v);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const seekTargetAt = (clientX: number, el: HTMLDivElement) => {
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return ratio * duration;
  };

  const seekingRef = useRef(false);
  const seekVisualRef = useRef<number | null>(null);
  const seekRafRef = useRef<number | null>(null);
  const seekPendingRef = useRef<{ x: number; el: HTMLDivElement } | null>(null);

  const seekPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    seekingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const target = seekTargetAt(e.clientX, e.currentTarget);
    seekVisualRef.current = target;
    setTime(target);
    flash(`⤓  ${fmt(target)}`);
  };

  const seekPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekingRef.current) return;
    seekPendingRef.current = { x: e.clientX, el: e.currentTarget };
    if (seekRafRef.current !== null) return;
    seekRafRef.current = requestAnimationFrame(() => {
      seekRafRef.current = null;
      const pending = seekPendingRef.current;
      if (!pending || !seekingRef.current) return;
      seekPendingRef.current = null;
      const target = seekTargetAt(pending.x, pending.el);
      seekVisualRef.current = target;
      setTime(target);
    });
  };

  const seekPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekingRef.current) return;
    const target = seekTargetAt(e.clientX, e.currentTarget);
    seekVisualRef.current = target;
    setTime(target);
    playerRef.current?.seekTo?.(target, true);
    playerRef.current?.playVideo?.();
    seekingRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const s = state.settings;
  const pct = duration ? (time / duration) * 100 : 0;

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full min-w-0 max-w-7xl items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4">
          <div className="flex shrink-0 items-center gap-2 font-bold tracking-tight">
            <img src="/app-icon.png" alt="" className="h-8 w-8 rounded-md object-cover" />
            <span className="hidden sm:flex sm:flex-col sm:leading-tight"><span>MIDI YouTube</span><span className="text-muted-foreground font-normal">for musicians</span></span>
          </div>
          <form onSubmit={doSearch} className="flex min-w-0 flex-1 max-w-2xl">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search YouTube"
              className="min-w-0 flex-1 rounded-l-full border border-input bg-card px-4 py-2 outline-none focus:border-primary" />
            <Button type="submit" variant="secondary" className="h-auto rounded-l-none rounded-r-full border border-l-0 border-input px-5">
              {searching ? "…" : "Search"}
            </Button>
          </form>
          <Button variant="secondary" size="icon" className="shrink-0" onClick={() => setSettingsOpen(true)}
            aria-label="MIDI Learn and Settings" aria-haspopup="dialog" title="MIDI Learn and Settings">
            <Settings2 />
          </Button>
          <span className={`hidden md:inline text-xs ${midiStatus === "Connected" ? "text-green-500" : "text-muted-foreground"}`}>
            MIDI: {midiStatus}
          </span>
        </div>
      </header>

      <main className="mx-auto w-full min-w-0 max-w-7xl overflow-x-hidden px-3 py-6 sm:px-4">
        <section>
          <div ref={stageRef} onPointerMove={showControls} onPointerDown={showControls} className="group relative aspect-video w-full overflow-hidden rounded-xl bg-black [&:fullscreen]:rounded-none [&:fullscreen]:aspect-auto">
            {/* iframe cropped top/bottom to hide title/share and "more videos" bars */}
            <div className="absolute inset-x-0 -top-[60px] -bottom-[60px]">
              <div ref={hostRef} className="h-full w-full" />
            </div>
            {/* click shield: blocks YouTube hover overlays */}
            <div className="absolute inset-0 z-10 cursor-pointer" onClick={() => runAction("playPause")} onDoubleClick={toggleFs} />
            {!state.lastVideo && (
              <div className="absolute inset-0 z-10 grid place-items-center text-muted-foreground pointer-events-none">Search and pick a video</div>
            )}
            {overlay && (
              <div key={overlay.key} className="pointer-events-none absolute inset-0 z-20 grid place-items-center -translate-y-0.5">
                <div className="animate-in fade-in zoom-in-95 rounded-2xl bg-background/80 px-8 py-4 text-3xl font-bold shadow-2xl backdrop-blur">
                  {overlay.text}
                </div>
              </div>
            )}
            <div className={'absolute inset-x-0 bottom-0 z-20 transition-opacity duration-200 ' + (controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0')}>
              <div className="relative flex justify-between px-3 pb-1 font-medium text-white drop-shadow -translate-y-0.5">
                <div className="absolute inset-x-0 -top-5 -bottom-1 -z-10 bg-gradient-to-t from-black/70 via-black/35 to-transparent" />
                <span style={{ fontSize: `${Math.max(11, Math.min(18, stageWidth * 0.014))}px` }}>{fmt(time)} / {fmt(duration)}</span>
                <span className="flex gap-3" style={{ fontSize: `${Math.max(11, Math.min(18, stageWidth * 0.014))}px`, lineHeight: 1.2 }}>
                  <span style={{ fontSize: "inherit" }}>{s.speed}x · {s.volume}%</span>
                  <button onClick={toggleFs} className="hover:text-primary" style={{ fontSize: "inherit", lineHeight: "inherit" }}>{isFs ? "Exit full screen" : "Full screen"}</button>
                </span>
              </div>
              <div
                className="relative -translate-y-[6px] h-1.5 w-full cursor-pointer touch-none overflow-visible bg-foreground/25 hover:h-2.5 transition-all"
                onPointerDown={seekPointerDown}
                onPointerMove={seekPointerMove}
                onPointerUp={seekPointerUp}
                onPointerCancel={seekPointerUp}
              >
                <div className="relative h-full bg-primary pointer-events-none" style={{ width: `${pct}%` }}>
                  <div className="absolute right-0 top-1/2 z-30 h-3.5 w-3.5 -translate-y-1/2 translate-x-1/2 rounded-full border-2 border-background bg-primary shadow-md" />
                </div>
              </div>
            </div>
          </div>
          <h1 className="mt-3 text-lg font-semibold">{state.lastVideo?.title ?? "No video selected"}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => runAction("back")}>« {s.seekStep}s</Button>
            <Button onClick={() => runAction("playPause")}>{playing ? "Pause" : "Play"}</Button>
            <Button variant="secondary" onClick={() => runAction("forward")}>{s.seekStep}s »</Button>
            <Button onClick={() => runAction("goto")} title={`Go to ${fmt((s.cues.goto?.m ?? 0) * 60 + (s.cues.goto?.s ?? 0))}`}>Go to</Button>
            <div className="hidden landscape:flex items-center gap-2">
              <Button variant="secondary" size="icon" onClick={() => runAction("volDown")} aria-label="Volume down" title="Volume -" className={actionButtonFlash === "volDown" ? "bg-primary text-primary-foreground ring-2 ring-primary scale-95 transition-transform" : "transition-transform"}><Volume1 /></Button>
              <Button variant="secondary" size="icon" onClick={() => runAction("volUp")} aria-label="Volume up" title="Volume +" className={actionButtonFlash === "volUp" ? "bg-primary text-primary-foreground ring-2 ring-primary scale-95 transition-transform" : "transition-transform"}><Volume2 /></Button>
              <Button variant="secondary" size="icon" onClick={() => runAction("speedDown")} aria-label="Decrease playback speed" title="Speed -" className={actionButtonFlash === "speedDown" ? "bg-primary text-primary-foreground ring-2 ring-primary scale-95 transition-transform" : "transition-transform"}><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABBAAAAQACAYAAABYs6prAAABGGVYSWZNTQAq
AAAACAAFAQAAAwAAAAEAAAAAAQEAAwAAAAEAAAAAh2kABAAAAAEAAABeARIA
AwAAAAEAAQAAATIAAgAAABQAAABKAAAAADIwMjY6MTA6MTIgMDc6NTY6MzYA
AAaQAwACAAAAFAAAAKygAgADAAAAAQQQAACQEAACAAAABwAAAMCgAwADAAAA
AQQAAACQEQACAAAABwAAAMeSCAADAAAAAQAAAAAAAAAAMjAyNjoxMDoxMiAw
Nzo1NjozNgArMDI6MDAAKzAyOjAwAAAEAQAAAwAAAAEAAAAAAQEAAwAAAAEA
AAAAARIAAwAAAAEAAQAAATIAAgAAABQAAAEEAAAAADIwMjY6MTA6MTIgMDc6
NTY6MzYAqqLqtAAAAARzQklUCAgICHwIZIgAAAABc1JHQgCuzhzpAAAgAElE
QVR4nOzdadi1Z1XY/bWAIGEmTC1iEgTRUIJAEAcSQpBBKYogg75AFcsrUhlt
oTYgIspk0VihFhEMlqGgAbS86muYYgIoQwhEZpBAIAIJmCgkKYFk9cNzCxnu
fY9773UNv99x5AMHR7L/9/Psve+913We5xUBAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAq5XdAQDA+lTVt0fEzSLi5hFxk4i4ZkRc
JyKuHxE32Pjn2pf7/64WEdeLiP8TEZdFxAUR8bWN/31pRFwcERde7p+LI+Ib
EfGpiDg/Is7KzPPW89MBAKtkgAAAE1FVN4yI4yLi+yLiByPidnFgWDBEn4iI
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
ALg6MxAAYEFVbSb5Z3QObqtvW2unRocAgKkzAwEAFrTWLiR5YnQObpvPFQ8A
4GDMQACAK6iqGp2BW+rZ1tqXo0MAwKowAwEArqD/Iv9bo3Nw033c9igeAMB1
MAMBAA6gql5N8tHoHNyw3SRvt9beGx0EAFaVAgIAXKeqOpTkyST3JTmW5N4k
R5L8nuRCkq0kOwtdlmf8zdeP9n6zJBtJ7u7Ls779Wv8KcKi3G/24fy6Mv7Ww
vGy+bd5/N0ktLM/bjew9K2wnuSfJxYV8i+eXpb5Jcn7hWH/0fHckudTHPbKU
Z7awnCSbfbxZ9q7TsZ7xUh9nc+GYO0ku93zbff1Mz/5za+2XfbICAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAADj/AvvOIVAKV4iDwAAAABJRU5ErkJgggAAoQsYAAAAUGhvdG9FZGl0
b3JfUmVfRWRpdF9EYXRheyJvcmlnaW5hbFBhdGgiOiJcL2RhdGFcL3NlY1wv
cGhvdG9lZGl0b3JcLzBcL2E1M2VjMTc3MTU2N2UxN2UyNjE5NThlMDVhYzBh
NTYzZGM3ZWMxNzZlM2NkNjJkODJjZjNjZDUyYTI0MjU0YzRfMjA2NTUucG5n
IiwicmVwcmVzZW50YXRpdmVGcmFtZUxvYyI6LTEsInN0YXJ0TW90aW9uVmlk
ZW8iOi0xLCJlbmRNb3Rpb25WaWRlbyI6LTEsImlzTW90aW9uVmlkZW9NdXRl
IjpmYWxzZSwiaXNUcmltTW90aW9uVmlkZW8iOmZhbHNlLCJjbGlwSW5mb1Zh
bHVlIjoie1wibUNlbnRlclhcIjowLjUsXCJtQ2VudGVyWVwiOjAuNSxcIm1X
aWR0aFwiOjEsXCJtSGVpZ2h0XCI6MSxcIm1Sb3RhdGlvblwiOi0wLFwibVJv
dGF0ZVwiOjAsXCJtSEZsaXBcIjoxLFwibVZGbGlwXCI6MCxcIm1Sb3RhdGlv
bkVmZmVjdFwiOjAsXCJtUm90YXRlRWZmZWN0XCI6MCxcIm1IRmxpcEVmZmVj
dFwiOjEsXCJtVkZsaXBFZmZlY3RcIjowLFwibUhvelBlcnNwZWN0aXZlXCI6
LTAsXCJtVmVyUGVyc3BlY3RpdmVcIjowfSIsInRvbmVWYWx1ZSI6IntcImJy
aWdodG5lc3NcIjoxMDAsXCJleHBvc3VyZVwiOjEwMCxcImNvbnRyYXN0XCI6
MTAwLFwic2F0dXJhdGlvblwiOjEwMCxcImh1ZVwiOjEwMCxcIndiTW9kZVwi
Oi0xLFwid2JUZW1wZXJhdHVyZVwiOjEwMCxcInRpbnRcIjoxMDAsXCJzaGFk
b3dcIjoxMDAsXCJoaWdobGlnaHRcIjoxMDAsXCJsaWdodGJhbGFuY2VcIjox
MDAsXCJzaGFycG5lc3NcIjoxMDAsXCJkZWZpbml0aW9uXCI6MTAwLFwiaXNC
cmlnaHRuZXNzSVBFXCI6ZmFsc2UsXCJpc0V4cG9zdXJlSVBFXCI6ZmFsc2Us
XCJpc0NvbnRyYXN0SVBFXCI6ZmFsc2UsXCJpc1NhdHVyYXRpb25JUEVcIjpm
YWxzZX0iLCJlZmZlY3RWYWx1ZSI6IntcImZpbHRlckluZGljYXRpb25cIjo0
MDk3LFwiYWxwaGFWYWx1ZVwiOjEwMCxcImZpbHRlclR5cGVcIjowfSIsInBv
cnRyYWl0RWZmZWN0VmFsdWUiOiJ7XCJlZmZlY3RJZFwiOi0xLFwiZWZmZWN0
TGV2ZWxcIjotMSxcImV4aWZSb3RhdGlvblwiOjAsXCJsaWdodExldmVsXCI6
MCxcInRvdWNoWFwiOjAsXCJ0b3VjaFlcIjowLFwicmVmb2N1c1hcIjotMSxc
InJlZm9jdXNZXCI6LTEsXCJlZmZlY3RJZE9yaWdpbmFsXCI6LTEsXCJlZmZl
Y3RMZXZlbE9yaWdpbmFsXCI6LTEsXCJsaWdodExldmVsT3JpZ2luYWxcIjot
MSxcInRvdWNoWE9yaWdpbmFsXCI6MCxcInRvdWNoWU9yaWdpbmFsXCI6MCxc
InJlZm9jdXNYT3JpZ2luYWxcIjotMSxcInJlZm9jdXNZT3JpZ2luYWxcIjot
MSxcIndhdGVyTWFya1JlbW92ZWRcIjpmYWxzZSxcIndhdGVyTWFya1JlbW92
ZWRPcmlnaW5hbFwiOmZhbHNlfSIsImlzQmxlbmRpbmciOnRydWUsImlzTm90
UmVFZGl0IjpmYWxzZSwic2VwVmVyc2lvbiI6IjE3MDUwMCIsIm5kZVZlcnNp
b24iOjEsInJlU2l6ZSI6NCwiaXNTY2FsZUFJIjpmYWxzZSwicm90YXRpb24i
OjEsImFkanVzdG1lbnRWYWx1ZSI6IntcIm1Dcm9wU3RhdGVcIjoxMzEwNzZ9
IiwiaXNBcHBseVNoYXBlQ29ycmVjdGlvbiI6ZmFsc2UsImlzTmV3UmVFZGl0
T25seSI6ZmFsc2UsImlzRGVjb1JlRWRpdE9ubHkiOmZhbHNlLCJpc0FJRmls
dGVyUmVFZGl0T25seSI6ZmFsc2UsImlzU1BlblNES09ubHkiOmZhbHNlfQAA
oQsWAAAAT3JpZ2luYWxfUGF0aF9IYXNoX0tleTQ5YmY4ZDNjMzQ3OTYyN2Uz
YTg1MjBmNTM0NzVmM2ViM2IxOTdiNWNiOTEyOWFkM2U0ZjU4MTZkMWFhYTIw
ZjQvMjA2NTVTRUZIawAAAAIAAAAAAKELxwYAAGMGAAAAAKELZAAAAGQAAAAk
AAAAU0VGVA==
" alt="" className="h-10 w-10 object-contain" /></Button>
              <Button variant="secondary" size="icon" onClick={() => runAction("speedUp")} aria-label="Increase playback speed" title="Speed +" className={actionButtonFlash === "speedUp" ? "bg-primary text-primary-foreground ring-2 ring-primary scale-95 transition-transform" : "transition-transform"}><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABBEAAAQACAYAAAC3ccFVAAAWfmNhQlgAABZ+
anVtYgAAAB5qdW1kYzJwYQARABCAAACqADibcQNjMnBhAAAAFlhqdW1iAAAA
R2p1bWRjMm1hABEAEIAAAKoAOJtxA3VybjpjMnBhOjQwOTMxZWQyLTAxOTgt
NDBkYS05NzU3LTNkOWYwMzMzZWYwYgAAAAOTanVtYgAAAClqdW1kYzJhcwAR
ABCAAACqADibcQNjMnBhLmFzc2VydGlvbnMAAAAAuGp1bWIAAABEanVtZGNi
b3IAEQAQgAAAqgA4m3ETYzJwYS5pbmdyZWRpZW50LnYzAAAAABhjMnNo1B/n
sEg7otUbbJFv8USwugAAAGxjYm9yo2lkYzpmb3JtYXRpaW1hZ2UvcG5namlu
c3RhbmNlSUR4LHhtcDppaWQ6YWFiMDE4Y2QtZTIyZC00NjBlLTkyNzQtYmZk
NjY4NTM1YjRkbHJlbGF0aW9uc2hpcGhwYXJlbnRPZgAAAeJqdW1iAAAAQWp1
bWRjYm9yABEAEIAAAKoAOJtxE2MycGEuYWN0aW9ucy52MgAAAAAYYzJzaAVj
v9j02+iAkLFtHNNO2EcAAAGZY2JvcqJnYWN0aW9uc4KiZmFjdGlvbmtjMnBh
Lm9wZW5lZGpwYXJhbWV0ZXJzoWtpbmdyZWRpZW50c4GiY3VybHgtc2VsZiNq
dW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5pbmdyZWRpZW50LnYzZGhhc2hY
IMUGWg+aQ0JnDR/vjIRqp+dMb2gic0RBnm8WvbRtyDFGpGZhY3Rpb254HWNv
bS5hbnRocm9waWMuY2xhdWRlLnByb3ZpZGVkanBhcmFtZXRlcnOheB9jb20u
YW50aHJvcGljLm9yaWdpbi1jb25maWRlbmNlZ3Vua25vd25rZGVzY3JpcHRp
b254ZkNsYXVkZSBwcm92aWRlZCB0aGlzIGZpbGUgYXQgdGhlIHJlcXVlc3Qg
b2YgYSB1c2VyIGFuZCBtYXkgaGF2ZSBjcmVhdGVkIG9yIG1vZGlmaWVkIHRo
ZSBmaWxlIGNvbnRlbnRzLm1zb2Z0d2FyZUFnZW50oWRuYW1lZkNsYXVkZXJh
bGxBY3Rpb25zSW5jbHVkZWT1AAAAyGp1bWIAAABAanVtZGNib3IAEQAQgAAA
qgA4m3ETYzJwYS5oYXNoLmRhdGEAAAAAGGMyc2gAbiN372sZy0dn9YIpthvQ
AAAAgGNib3KlY2FsZ2ZzaGEyNTZjcGFkTQAAAAAAAAAAAAAAAABkaGFzaFgg
RU/tvWQd2tR+tADYWT9WGVaY2SDykoJ4SZVWXllgbsVkbmFtZW5qdW1iZiBt
YW5pZmVzdGpleGNsdXNpb25zgaJlc3RhcnQYIWZsZW5ndGgZFooAAAI+anVt
YgAAACdqdW1kYzJjbAARABCAAACqADibcQNjMnBhLmNsYWltLnYyAAAAAg9j
Ym9ypWNhbGdmc2hhMjU2aXNpZ25hdHVyZXhNc2VsZiNqdW1iZj0vYzJwYS91
cm46YzJwYTo0MDkzMWVkMi0wMTk4LTQwZGEtOTc1Ny0zZDlmMDMzM2VmMGIv
YzJwYS5zaWduYXR1cmVqaW5zdGFuY2VJRHgseG1wOmlpZDo3OWIyNjVhNy01
MmFkLTRiMGItOGU4Ni0wMmI3YzY0OGE5ZDNyY3JlYXRlZF9hc3NlcnRpb25z
g6JjdXJseC1zZWxmI2p1bWJmPWMycGEuYXNzZXJ0aW9ucy9jMnBhLmluZ3Jl
ZGllbnQudjNkaGFzaFggxQZaD5pDQmcNH++MhGqn50xvaCJzREGebxa9tG3I
MUaiY3VybHgqc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5hY3Rp
b25zLnYyZGhhc2hYIGMp2NX7JonTBPdZ7SwoLkxQeVx7LTimxrv9meeMHypk
omN1cmx4KXNlbGYjanVtYmY9YzJwYS5hc3NlcnRpb25zL2MycGEuaGFzaC5k
YXRhZGhhc2hYIMDHge0NPMhDqSApYiyZq884vWBHSN2osx980HUblJqDdGNs
YWltX2dlbmVyYXRvcl9pbmZvo2RuYW1lb0FudGhyb3BpYyBGaWxlc2d2ZXJz
aW9uZTEuMC4wa3NwZWNWZXJzaW9uZTIuNC4wAAAQOGp1bWIAAAAoanVtZGMy
Y3MAEQAQgAAAqgA4m3EDYzJwYS5zaWduYXR1cmUAAAAQCGNib3LShFkCEqIB
JhghWQIKMIICBjCCAY2gAwIBAgIUQOWgCu7COdC+uIP6BkIFPWdVEwAwCgYI
KoZIzj0EAwMwSTEXMBUGA1UEChMOQW50aHJvcGljLCBQQkMxLjAsBgNVBAMT
JUFudGhyb3BpYyBDb250ZW50IENyZWRlbnRpYWxzIFJvb3QgQ0EwHhcNMjYw
ODA3MTg0MzU2WhcNMjgwODA2MTk0MzU2WjBEMRcwFQYDVQQKEw5BbnRocm9w
aWMsIFBCQzEpMCcGA1UEAxMgQW50aHJvcGljIENsYXVkZSBDb250ZW50IFNp
Z25pbmcwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASYegpry1AYBRTVNL1C
pTlbROnY3dey+UrsF9C3phYrATN3ZHf93Mo8RQN0KOUuOn19P4oWNFWe5n2/
She9N7eTo1gwVjAOBgNVHQ8BAf8EBAMCB4AwFQYDVR0lBA4wDAYKKwYBBAGD
6F4CATAMBgNVHRMBAf8EAjAAMB8GA1UdIwQYMBaAFM5R4gSBTmRbI/jjxM+a
PpzB11zCMAoGCCqGSM49BAMDA2cAMGQCMDFzHRSeAXrSy1WOzkbhPZ6Km2wG
TmZ/2gK18k8BQGXyqz88Rdrz6CTX9flAnYNVxgIwcF9c3fVhqmJKpi+UhasN
UMko69cyX6STPfta3Q8EjyzDjzoyrol46FP6VFHhvUcJoWNwYWRZDZ4AAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAD2WECLuhjE4qRmFxGek4tly6D9ZbCT9QfxdzlT
CRGqMx90zUvZmzLYy24XZrIaPTbHtmNKO9JiPwB6+STOzbp5LGPg0PrMtgAA
OzdJREFUeJzt3XnY7fd87//XJhJBglSixgY9pmNuqai5xjqqZi1Ka6gqpw51
aH9aSqvnGKs9rdKiyNGigvS0RZuUGEM55qklwmUKIqZESOzfH2uryLmH972m
9/f7XY/HdeVKXZX9fcne91rrft6f71r79u/fHwAAAIDdXKB7AAAAADAOIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQ
IiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQ
IiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQ
IiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUH
dQ8AAOZ2SJJLJ7lskiOSHJof/IDgqAP/9wUze76/QJLvJDn7PH+dk+RbSb6W
5ItJvpDk6+ubDwCMjYgAAMNwSJLrJvmpJFdPcvPMQsBRnaPO45Qk707y/iQf
OPD3T7YuAgDWbt/+/fu7NwDAprh0ktsnuVaSOyW5Zu+cpftgkhOT/FOSE5Kc
1TsHAFg2EQEAVuMmSR6Q5N5JLt68pdsnkvxdkuOSvLl5CwCwABEBABa3L8nD
k/y3JFdp3jIWpyR5WZLnJ/l08xYAoEhEAIC9u0SS303yK3HKYFnOTPLcJE/P
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
7SQCAGwQEQEAxu+gxmtfsPHaAMCaiQgAMH6dJxEAgA0iIgDA+HXeUnBu47UB
gDUTEQBg/NzOAACshYgAAOP35cZrn914bQBgzUQEABi/NzZe+32N1wYA1kxE
AIDx+1TjtU9uvDYAsGb79u/f370BAFhc1xP6vqbrAgANnEQAgGn4m+4BAMD0
iQgAMA2/1HDNlzVcEwBo5HYGAJiOs5McvMbruZUBADaMkwgAMB2XW+O1Tlzj
tQCAgXASAQCm5QNJrrWG6ziFAAAbyEkEAJiWa6/hGrdbwzUAgAESEQBgelZ5
SuDZSf5phb8+ADBgB3UPAABWYl+SZd+z+PAkz13yrwkAjIiIAADTtS+zUwO3
WdKvBQBsOLczAMC03TbJJZN8b85//h4REACAA0QEAJi+M5JcMMmFM3tPg6/u
8N/9TpKXJTkqs3jwqlWPAwDGw0c8AgAAACVOIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQ
IiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQ
IiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl/z8+0iec
KwDhyQAAAABJRU5ErkJggg==
" alt="" className="h-10 w-10 object-contain" /></Button>
            </div>
            <div className="hidden portrait:flex items-center gap-2"><div className="flex items-center gap-1"><Button variant="secondary" size="icon" onClick={() => runAction("volDown")} aria-label="Volume down" title="Volume -" className={actionButtonFlash === "volDown" ? "bg-primary text-primary-foreground ring-2 ring-primary scale-95 transition-transform" : "transition-transform"}><Volume1 /></Button><Button variant="secondary" size="icon" onClick={() => runAction("volUp")} aria-label="Volume up" title="Volume +" className={actionButtonFlash === "volUp" ? "bg-primary text-primary-foreground ring-2 ring-primary scale-95 transition-transform" : "transition-transform"}><Volume2 /></Button></div><div className="flex items-center gap-1"><Button variant="secondary" size="icon" onClick={() => runAction("speedDown")} aria-label="Decrease playback speed" title="Speed -" className={actionButtonFlash === "speedDown" ? "bg-primary text-primary-foreground ring-2 ring-primary scale-95 transition-transform" : "transition-transform"}><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABBAAAAQACAYAAABYs6prAAABGGVYSWZNTQAq
AAAACAAFAQAAAwAAAAEAAAAAAQEAAwAAAAEAAAAAh2kABAAAAAEAAABeARIA
AwAAAAEAAQAAATIAAgAAABQAAABKAAAAADIwMjY6MTA6MTIgMDc6NTY6MzYA
AAaQAwACAAAAFAAAAKygAgADAAAAAQQQAACQEAACAAAABwAAAMCgAwADAAAA
AQQAAACQEQACAAAABwAAAMeSCAADAAAAAQAAAAAAAAAAMjAyNjoxMDoxMiAw
Nzo1NjozNgArMDI6MDAAKzAyOjAwAAAEAQAAAwAAAAEAAAAAAQEAAwAAAAEA
AAAAARIAAwAAAAEAAQAAATIAAgAAABQAAAEEAAAAADIwMjY6MTA6MTIgMDc6
NTY6MzYAqqLqtAAAAARzQklUCAgICHwIZIgAAAABc1JHQgCuzhzpAAAgAElE
QVR4nOzdadi1Z1XY/bWAIGEmTC1iEgTRUIJAEAcSQpBBKYogg75AFcsrUhlt
oTYgIspk0VihFhEMlqGgAbS86muYYgIoQwhEZpBAIAIJmCgkKYFk9cNzCxnu
fY9773UNv99x5AMHR7L/9/Psve+913We5xUBAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAq5XdAQDA+lTVt0fEzSLi5hFxk4i4ZkRc
JyKuHxE32Pjn2pf7/64WEdeLiP8TEZdFxAUR8bWN/31pRFwcERde7p+LI+Ib
EfGpiDg/Is7KzPPW89MBAKtkgAAAE1FVN4yI4yLi+yLiByPidnFgWDBEn4iI
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
ALg6MxAAYEFVbSb5Z3QObqtvW2unRocAgKkzAwEAFrTWLiR5YnQObpvPFQ8A
4GDMQACAK6iqGp2BW+rZ1tqXo0MAwKowAwEArqD/Iv9bo3Nw033c9igeAMB1
MAMBAA6gql5N8tHoHNyw3SRvt9beGx0EAFaVAgIAXKeqOpTkyST3JTmW5N4k
R5L8nuRCkq0kOwtdlmf8zdeP9n6zJBtJ7u7Ls779Wv8KcKi3G/24fy6Mv7Ww
vGy+bd5/N0ktLM/bjew9K2wnuSfJxYV8i+eXpb5Jcn7hWH/0fHckudTHPbKU
Z7awnCSbfbxZ9q7TsZ7xUh9nc+GYO0ku93zbff1Mz/5za+2XfbICAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAADj/AvvOIVAKV4iDwAAAABJRU5ErkJgggAAoQsYAAAAUGhvdG9FZGl0
b3JfUmVfRWRpdF9EYXRheyJvcmlnaW5hbFBhdGgiOiJcL2RhdGFcL3NlY1wv
cGhvdG9lZGl0b3JcLzBcL2E1M2VjMTc3MTU2N2UxN2UyNjE5NThlMDVhYzBh
NTYzZGM3ZWMxNzZlM2NkNjJkODJjZjNjZDUyYTI0MjU0YzRfMjA2NTUucG5n
IiwicmVwcmVzZW50YXRpdmVGcmFtZUxvYyI6LTEsInN0YXJ0TW90aW9uVmlk
ZW8iOi0xLCJlbmRNb3Rpb25WaWRlbyI6LTEsImlzTW90aW9uVmlkZW9NdXRl
IjpmYWxzZSwiaXNUcmltTW90aW9uVmlkZW8iOmZhbHNlLCJjbGlwSW5mb1Zh
bHVlIjoie1wibUNlbnRlclhcIjowLjUsXCJtQ2VudGVyWVwiOjAuNSxcIm1X
aWR0aFwiOjEsXCJtSGVpZ2h0XCI6MSxcIm1Sb3RhdGlvblwiOi0wLFwibVJv
dGF0ZVwiOjAsXCJtSEZsaXBcIjoxLFwibVZGbGlwXCI6MCxcIm1Sb3RhdGlv
bkVmZmVjdFwiOjAsXCJtUm90YXRlRWZmZWN0XCI6MCxcIm1IRmxpcEVmZmVj
dFwiOjEsXCJtVkZsaXBFZmZlY3RcIjowLFwibUhvelBlcnNwZWN0aXZlXCI6
LTAsXCJtVmVyUGVyc3BlY3RpdmVcIjowfSIsInRvbmVWYWx1ZSI6IntcImJy
aWdodG5lc3NcIjoxMDAsXCJleHBvc3VyZVwiOjEwMCxcImNvbnRyYXN0XCI6
MTAwLFwic2F0dXJhdGlvblwiOjEwMCxcImh1ZVwiOjEwMCxcIndiTW9kZVwi
Oi0xLFwid2JUZW1wZXJhdHVyZVwiOjEwMCxcInRpbnRcIjoxMDAsXCJzaGFk
b3dcIjoxMDAsXCJoaWdobGlnaHRcIjoxMDAsXCJsaWdodGJhbGFuY2VcIjox
MDAsXCJzaGFycG5lc3NcIjoxMDAsXCJkZWZpbml0aW9uXCI6MTAwLFwiaXNC
cmlnaHRuZXNzSVBFXCI6ZmFsc2UsXCJpc0V4cG9zdXJlSVBFXCI6ZmFsc2Us
XCJpc0NvbnRyYXN0SVBFXCI6ZmFsc2UsXCJpc1NhdHVyYXRpb25JUEVcIjpm
YWxzZX0iLCJlZmZlY3RWYWx1ZSI6IntcImZpbHRlckluZGljYXRpb25cIjo0
MDk3LFwiYWxwaGFWYWx1ZVwiOjEwMCxcImZpbHRlclR5cGVcIjowfSIsInBv
cnRyYWl0RWZmZWN0VmFsdWUiOiJ7XCJlZmZlY3RJZFwiOi0xLFwiZWZmZWN0
TGV2ZWxcIjotMSxcImV4aWZSb3RhdGlvblwiOjAsXCJsaWdodExldmVsXCI6
MCxcInRvdWNoWFwiOjAsXCJ0b3VjaFlcIjowLFwicmVmb2N1c1hcIjotMSxc
InJlZm9jdXNZXCI6LTEsXCJlZmZlY3RJZE9yaWdpbmFsXCI6LTEsXCJlZmZl
Y3RMZXZlbE9yaWdpbmFsXCI6LTEsXCJsaWdodExldmVsT3JpZ2luYWxcIjot
MSxcInRvdWNoWE9yaWdpbmFsXCI6MCxcInRvdWNoWU9yaWdpbmFsXCI6MCxc
InJlZm9jdXNYT3JpZ2luYWxcIjotMSxcInJlZm9jdXNZT3JpZ2luYWxcIjot
MSxcIndhdGVyTWFya1JlbW92ZWRcIjpmYWxzZSxcIndhdGVyTWFya1JlbW92
ZWRPcmlnaW5hbFwiOmZhbHNlfSIsImlzQmxlbmRpbmciOnRydWUsImlzTm90
UmVFZGl0IjpmYWxzZSwic2VwVmVyc2lvbiI6IjE3MDUwMCIsIm5kZVZlcnNp
b24iOjEsInJlU2l6ZSI6NCwiaXNTY2FsZUFJIjpmYWxzZSwicm90YXRpb24i
OjEsImFkanVzdG1lbnRWYWx1ZSI6IntcIm1Dcm9wU3RhdGVcIjoxMzEwNzZ9
IiwiaXNBcHBseVNoYXBlQ29ycmVjdGlvbiI6ZmFsc2UsImlzTmV3UmVFZGl0
T25seSI6ZmFsc2UsImlzRGVjb1JlRWRpdE9ubHkiOmZhbHNlLCJpc0FJRmls
dGVyUmVFZGl0T25seSI6ZmFsc2UsImlzU1BlblNES09ubHkiOmZhbHNlfQAA
oQsWAAAAT3JpZ2luYWxfUGF0aF9IYXNoX0tleTQ5YmY4ZDNjMzQ3OTYyN2Uz
YTg1MjBmNTM0NzVmM2ViM2IxOTdiNWNiOTEyOWFkM2U0ZjU4MTZkMWFhYTIw
ZjQvMjA2NTVTRUZIawAAAAIAAAAAAKELxwYAAGMGAAAAAKELZAAAAGQAAAAk
AAAAU0VGVA==
" alt="" className="h-10 w-10 object-contain" /></Button><Button variant="secondary" size="icon" onClick={() => runAction("speedUp")} aria-label="Increase playback speed" title="Speed +" className={actionButtonFlash === "speedUp" ? "bg-primary text-primary-foreground ring-2 ring-primary scale-95 transition-transform" : "transition-transform"}><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABBEAAAQACAYAAAC3ccFVAAAWfmNhQlgAABZ+
anVtYgAAAB5qdW1kYzJwYQARABCAAACqADibcQNjMnBhAAAAFlhqdW1iAAAA
R2p1bWRjMm1hABEAEIAAAKoAOJtxA3VybjpjMnBhOjQwOTMxZWQyLTAxOTgt
NDBkYS05NzU3LTNkOWYwMzMzZWYwYgAAAAOTanVtYgAAAClqdW1kYzJhcwAR
ABCAAACqADibcQNjMnBhLmFzc2VydGlvbnMAAAAAuGp1bWIAAABEanVtZGNi
b3IAEQAQgAAAqgA4m3ETYzJwYS5pbmdyZWRpZW50LnYzAAAAABhjMnNo1B/n
sEg7otUbbJFv8USwugAAAGxjYm9yo2lkYzpmb3JtYXRpaW1hZ2UvcG5namlu
c3RhbmNlSUR4LHhtcDppaWQ6YWFiMDE4Y2QtZTIyZC00NjBlLTkyNzQtYmZk
NjY4NTM1YjRkbHJlbGF0aW9uc2hpcGhwYXJlbnRPZgAAAeJqdW1iAAAAQWp1
bWRjYm9yABEAEIAAAKoAOJtxE2MycGEuYWN0aW9ucy52MgAAAAAYYzJzaAVj
v9j02+iAkLFtHNNO2EcAAAGZY2JvcqJnYWN0aW9uc4KiZmFjdGlvbmtjMnBh
Lm9wZW5lZGpwYXJhbWV0ZXJzoWtpbmdyZWRpZW50c4GiY3VybHgtc2VsZiNq
dW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5pbmdyZWRpZW50LnYzZGhhc2hY
IMUGWg+aQ0JnDR/vjIRqp+dMb2gic0RBnm8WvbRtyDFGpGZhY3Rpb254HWNv
bS5hbnRocm9waWMuY2xhdWRlLnByb3ZpZGVkanBhcmFtZXRlcnOheB9jb20u
YW50aHJvcGljLm9yaWdpbi1jb25maWRlbmNlZ3Vua25vd25rZGVzY3JpcHRp
b254ZkNsYXVkZSBwcm92aWRlZCB0aGlzIGZpbGUgYXQgdGhlIHJlcXVlc3Qg
b2YgYSB1c2VyIGFuZCBtYXkgaGF2ZSBjcmVhdGVkIG9yIG1vZGlmaWVkIHRo
ZSBmaWxlIGNvbnRlbnRzLm1zb2Z0d2FyZUFnZW50oWRuYW1lZkNsYXVkZXJh
bGxBY3Rpb25zSW5jbHVkZWT1AAAAyGp1bWIAAABAanVtZGNib3IAEQAQgAAA
qgA4m3ETYzJwYS5oYXNoLmRhdGEAAAAAGGMyc2gAbiN372sZy0dn9YIpthvQ
AAAAgGNib3KlY2FsZ2ZzaGEyNTZjcGFkTQAAAAAAAAAAAAAAAABkaGFzaFgg
RU/tvWQd2tR+tADYWT9WGVaY2SDykoJ4SZVWXllgbsVkbmFtZW5qdW1iZiBt
YW5pZmVzdGpleGNsdXNpb25zgaJlc3RhcnQYIWZsZW5ndGgZFooAAAI+anVt
YgAAACdqdW1kYzJjbAARABCAAACqADibcQNjMnBhLmNsYWltLnYyAAAAAg9j
Ym9ypWNhbGdmc2hhMjU2aXNpZ25hdHVyZXhNc2VsZiNqdW1iZj0vYzJwYS91
cm46YzJwYTo0MDkzMWVkMi0wMTk4LTQwZGEtOTc1Ny0zZDlmMDMzM2VmMGIv
YzJwYS5zaWduYXR1cmVqaW5zdGFuY2VJRHgseG1wOmlpZDo3OWIyNjVhNy01
MmFkLTRiMGItOGU4Ni0wMmI3YzY0OGE5ZDNyY3JlYXRlZF9hc3NlcnRpb25z
g6JjdXJseC1zZWxmI2p1bWJmPWMycGEuYXNzZXJ0aW9ucy9jMnBhLmluZ3Jl
ZGllbnQudjNkaGFzaFggxQZaD5pDQmcNH++MhGqn50xvaCJzREGebxa9tG3I
MUaiY3VybHgqc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5hY3Rp
b25zLnYyZGhhc2hYIGMp2NX7JonTBPdZ7SwoLkxQeVx7LTimxrv9meeMHypk
omN1cmx4KXNlbGYjanVtYmY9YzJwYS5hc3NlcnRpb25zL2MycGEuaGFzaC5k
YXRhZGhhc2hYIMDHge0NPMhDqSApYiyZq884vWBHSN2osx980HUblJqDdGNs
YWltX2dlbmVyYXRvcl9pbmZvo2RuYW1lb0FudGhyb3BpYyBGaWxlc2d2ZXJz
aW9uZTEuMC4wa3NwZWNWZXJzaW9uZTIuNC4wAAAQOGp1bWIAAAAoanVtZGMy
Y3MAEQAQgAAAqgA4m3EDYzJwYS5zaWduYXR1cmUAAAAQCGNib3LShFkCEqIB
JhghWQIKMIICBjCCAY2gAwIBAgIUQOWgCu7COdC+uIP6BkIFPWdVEwAwCgYI
KoZIzj0EAwMwSTEXMBUGA1UEChMOQW50aHJvcGljLCBQQkMxLjAsBgNVBAMT
JUFudGhyb3BpYyBDb250ZW50IENyZWRlbnRpYWxzIFJvb3QgQ0EwHhcNMjYw
ODA3MTg0MzU2WhcNMjgwODA2MTk0MzU2WjBEMRcwFQYDVQQKEw5BbnRocm9w
aWMsIFBCQzEpMCcGA1UEAxMgQW50aHJvcGljIENsYXVkZSBDb250ZW50IFNp
Z25pbmcwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASYegpry1AYBRTVNL1C
pTlbROnY3dey+UrsF9C3phYrATN3ZHf93Mo8RQN0KOUuOn19P4oWNFWe5n2/
She9N7eTo1gwVjAOBgNVHQ8BAf8EBAMCB4AwFQYDVR0lBA4wDAYKKwYBBAGD
6F4CATAMBgNVHRMBAf8EAjAAMB8GA1UdIwQYMBaAFM5R4gSBTmRbI/jjxM+a
PpzB11zCMAoGCCqGSM49BAMDA2cAMGQCMDFzHRSeAXrSy1WOzkbhPZ6Km2wG
TmZ/2gK18k8BQGXyqz88Rdrz6CTX9flAnYNVxgIwcF9c3fVhqmJKpi+UhasN
UMko69cyX6STPfta3Q8EjyzDjzoyrol46FP6VFHhvUcJoWNwYWRZDZ4AAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAD2WECLuhjE4qRmFxGek4tly6D9ZbCT9QfxdzlT
CRGqMx90zUvZmzLYy24XZrIaPTbHtmNKO9JiPwB6+STOzbp5LGPg0PrMtgAA
OzdJREFUeJzt3XnY7fd87//XJhJBglSixgY9pmNuqai5xjqqZi1Ka6gqpw51
aH9aSqvnGKs9rdKiyNGigvS0RZuUGEM55qklwmUKIqZESOzfH2uryLmH972m
9/f7XY/HdeVKXZX9fcne91rrft6f71r79u/fHwAAAIDdXKB7AAAAADAOIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQ
IiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQ
IiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQ
IiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUH
dQ8AAOZ2SJJLJ7lskiOSHJof/IDgqAP/9wUze76/QJLvJDn7PH+dk+RbSb6W
5ItJvpDk6+ubDwCMjYgAAMNwSJLrJvmpJFdPcvPMQsBRnaPO45Qk707y/iQf
OPD3T7YuAgDWbt/+/fu7NwDAprh0ktsnuVaSOyW5Zu+cpftgkhOT/FOSE5Kc
1TsHAFg2EQEAVuMmSR6Q5N5JLt68pdsnkvxdkuOSvLl5CwCwABEBABa3L8nD
k/y3JFdp3jIWpyR5WZLnJ/l08xYAoEhEAIC9u0SS303yK3HKYFnOTPLcJE/P
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
7SQCAGwQEQEAxu+gxmtfsPHaAMCaiQgAMH6dJxEAgA0iIgDA+HXeUnBu47UB
gDUTEQBg/NzOAACshYgAAOP35cZrn914bQBgzUQEABi/NzZe+32N1wYA1kxE
AIDx+1TjtU9uvDYAsGb79u/f370BAFhc1xP6vqbrAgANnEQAgGn4m+4BAMD0
iQgAMA2/1HDNlzVcEwBo5HYGAJiOs5McvMbruZUBADaMkwgAMB2XW+O1Tlzj
tQCAgXASAQCm5QNJrrWG6ziFAAAbyEkEAJiWa6/hGrdbwzUAgAESEQBgelZ5
SuDZSf5phb8+ADBgB3UPAABWYl+SZd+z+PAkz13yrwkAjIiIAADTtS+zUwO3
WdKvBQBsOLczAMC03TbJJZN8b85//h4REACAA0QEAJi+M5JcMMmFM3tPg6/u
8N/9TpKXJTkqs3jwqlWPAwDGw0c8AgAAACVOIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQ
IiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQ
IiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAA
JSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAA
UCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAA
ACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAA
AFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAA
AAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIA
AABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIA
AAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSIC
AAAAUCIiAAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIi
AAAAACUiAgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUi
AgAAAFAiIgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAi
IgAAAAAlIgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl
IgIAAABQIiIAAAAAJSICAAAAUCIiAAAAACUiAgAAAFAiIgAAAAAl/z8+0iec
KwDhyQAAAABJRU5ErkJggg==
" alt="" className="h-10 w-10 object-contain" /></Button></div></div>
            <Button variant={state.favorites.some((f) => f.id === state.lastVideo?.id) ? "default" : "secondary"} size="icon" onClick={toggleFavorite}
              disabled={!state.lastVideo} aria-label="Add to favorites" title="Add/remove from favorites">
              <Heart className={state.favorites.some((f) => f.id === state.lastVideo?.id) ? "fill-current" : ""} />
            </Button>
          </div>

          <h2 className="mt-8 mb-3 text-sm uppercase tracking-wider text-muted-foreground">
            {state.lastQuery ? `Results for “${state.lastQuery}”` : "Search results"}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {state.lastResults.map((v) => {
              const active = state.lastVideo?.id === v.id;
              return (
                <button key={v.id} onClick={() => pick(v)}
                  className={`group/card rounded-xl p-2 text-left transition-all duration-200 hover:-translate-y-1 hover:bg-card hover:ring-2 hover:ring-primary/60 ${
                    selected === v.id ? "bg-primary text-primary-foreground ring-2 ring-primary" : active ? "bg-card ring-1 ring-primary/40" : ""}`}>
                  <div className="relative overflow-hidden rounded-lg">
                    <img src={v.thumbnail} alt="" loading="lazy" className="aspect-video w-full object-cover transition-transform group-hover/card:scale-105" />
                    <span className="absolute bottom-1 right-1 rounded bg-background/85 px-1.5 text-xs text-foreground">{v.duration}</span>
                  </div>
                  <div className="mt-2 line-clamp-2 text-sm font-medium">{v.title}</div>
                  <div className={`text-xs ${selected === v.id ? "" : "text-muted-foreground"}`}>{v.channel} · {v.views}</div>
                </button>
              );
            })}
          </div>
        </section>

        <Dialog open={settingsOpen} onOpenChange={(open) => { setSettingsOpen(open); if (!open) setLearning(null); }}>
          <DialogContent aria-describedby={undefined} className="box-border flex w-[calc(100vw-1rem)] max-w-xl max-h-[85dvh] flex-col overflow-hidden rounded-lg p-4 sm:p-6">
            <DialogHeader className="shrink-0">
              <DialogTitle>MIDI Learn & Settings</DialogTitle>
            </DialogHeader>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pt-4">
          <section>
            <h2 className="font-semibold">MIDI Learn</h2>
            <p className="mt-1 min-w-0 break-words text-xs text-muted-foreground">
              {devices.length ? devices.join(", ") : midiStatus}{lastMsg && ` · last: ${lastMsg}`}
            </p>
            <button
              type="button"
              onClick={connectMidi}
              className="mt-2 rounded bg-secondary px-3 py-1.5 text-xs font-medium hover:bg-accent"
            >
              Connect MIDI
            </button>
            <ul className="mt-3 space-y-1.5">
              {ACTIONS.map((a) => (
                <li key={a.id} className="min-w-0 overflow-hidden rounded-md bg-background/50 p-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{a.label}</span>
                    <code className="max-w-[38%] shrink truncate text-xs text-muted-foreground">{s.mappings[a.id] ?? "—"}</code>
                    <button onClick={() => setLearning(learning === a.id ? null : a.id)}
                      className={`rounded px-2 py-0.5 text-xs ${learning === a.id ? "bg-primary text-primary-foreground animate-pulse" : "bg-secondary hover:bg-accent"}`}>
                      {learning === a.id ? "Press…" : "Learn"}
                    </button>
                    {s.mappings[a.id] && (
                      <button onClick={() => setSettings((x) => { const m = { ...x.mappings }; delete m[a.id]; return { ...x, mappings: m }; })}
                        className="text-xs text-muted-foreground hover:text-destructive">✕</button>
                    )}
                  </div>
                  {a.id === "goto" && (
                    <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <input type="number" min={0} value={s.cues.goto?.m ?? 0}
                        onChange={(e) => setGoto({ m: Math.max(0, +e.target.value), s: s.cues.goto?.s ?? 0 })}
                        className="w-14 rounded border border-input bg-background px-1.5 py-0.5" /> min
                      <input type="number" min={0} max={59} value={s.cues.goto?.s ?? 0}
                        onChange={(e) => setGoto({ m: s.cues.goto?.m ?? 0, s: Math.min(59, Math.max(0, +e.target.value)) })}
                        className="w-14 rounded border border-input bg-background px-1.5 py-0.5" /> sec
                      <button onClick={() => { const t = Math.floor(time); setGoto({ m: Math.floor(t / 60), s: t % 60 }); }}
                        className="rounded bg-secondary px-2 py-0.5 hover:bg-accent">Current</button>                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section className="border-t border-border pt-4 space-y-3 text-sm">
            <h2 className="font-semibold">Settings</h2>
            <label className="flex items-center justify-between">Forward / back step (sec)
              <input type="number" min={1} max={600} value={s.seekStep}
                onChange={(e) => setSettings((x) => ({ ...x, seekStep: Math.max(1, +e.target.value || 1) }))}
                className="w-20 rounded border border-input bg-background px-2 py-1" />
            </label>
            <label className="flex items-center justify-between gap-4">Auto full screen on external display / DeX
              <input type="checkbox" checked={s.autoFullscreen} onChange={(e) => setSettings((x) => ({ ...x, autoFullscreen: e.target.checked }))} className="accent-primary h-4 w-4" />
            </label>
          </section>          <section className="border-t border-border pt-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Favorites</h2>
              <Heart className="h-4 w-4 text-muted-foreground" />
            </div>
            {state.favorites.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No favorites yet. Press the heart next to “Go to” to save the current video and its Go to position.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {state.favorites.map((f) => {
                  const gotoSeconds = f.goto.m * 60 + f.goto.s;
                  return (
                    <li key={f.id} className="flex min-w-0 items-center gap-2 overflow-hidden rounded-md bg-background/50 p-2">
                      <button onClick={() => openFavorite(f)} className="min-w-0 flex-1 text-left hover:text-primary">
                        <span className="block truncate text-sm font-medium">{f.title}</span>
                        <span className="text-xs text-muted-foreground">Go to {fmt(gotoSeconds)}</span>
                      </button>
                      <a href={"https://www.youtube.com/watch?v=" + f.id + "&t=" + gotoSeconds + "s"} target="_blank" rel="noreferrer"
                        className="rounded bg-secondary px-2 py-1 text-xs hover:bg-accent" title="Open YouTube video at Go to position">
                        Link
                      </a>
                      <button onClick={() => setState((x) => ({ ...x, favorites: x.favorites.filter((item) => item.id !== f.id) }))}
                        className="text-xs text-muted-foreground hover:text-destructive" aria-label="Remove favorite">✕</button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
            </div>

          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}
