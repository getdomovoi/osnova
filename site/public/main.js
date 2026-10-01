// Progressive enhancement: without this script every panel shows and every animation rests on its final frame.
document.documentElement.classList.add("js");

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const live = document.querySelector("[data-live]");

function announce(text) {
  if (live) live.textContent = text;
}

function buildMark() {
  const mark = document.querySelector(".bar .mark");
  if (!mark || reduceMotion.matches) return;
  mark.classList.add("building");
}

const SVG = "http://www.w3.org/2000/svg";

function svg(tag, attrs, parent) {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  if (parent) parent.append(el);
  return el;
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));

// Scene 2: a field of files. A column lights when the shuttle crosses it, so its cue time follows its x.
const READ_SWEEP = { from: 600, to: 3200, x0: 10, x1: 990 };

function buildFiles(host) {
  if (!host) return;
  for (let c = 0; c < 20; c += 1) {
    const cx = 25 + c * 50;
    const at = READ_SWEEP.from + ((cx - READ_SWEEP.x0) / (READ_SWEEP.x1 - READ_SWEEP.x0)) * (READ_SWEEP.to - READ_SWEEP.from);
    const col = svg("g", { class: "col", "data-at": Math.round(at) }, host);
    for (let r = 0; r < 6; r += 1) {
      const x = cx - 9;
      const y = 13 + r * 50;
      svg("path", { class: "file", d: `M${x} ${y}h12l6 6v18h-18zM${x + 4} ${y + 10}h10M${x + 4} ${y + 15}h10M${x + 4} ${y + 20}h6` }, col);
    }
  }
  svg("line", { class: "shuttle", x1: 0, y1: 0, x2: 0, y2: 300, "data-shuttle": "" }, host);
}

// Scene 4: refreshWorkspace and the callees osnova 0.11.0 resolved for it, with the line of each call.
const CALLEES = [
  ["cacheLimits", 93], ["resolveCacheDir", 94], ["withCacheLock", 105], ["workspaceLockPath", 105],
  ["artifactSignature", 106], ["readGeneration", 108], ["indexGeneration", 115], ["isRebuildableCacheFailure", 121],
  ["evictLru", 152], ["rememberLoaded", 163], ["cacheLockTimeoutIn", 182],
];

function buildWeave(host) {
  if (!host) return;
  const names = ["refreshWorkspace", ...CALLEES.map(([name]) => name)];
  const xs = names.map((_, i) => 50 + i * 82);
  names.forEach((name, i) => {
    const root = i === 0 ? " root" : "";
    const thread = svg("line", { class: `thread grow-y${root}`, x1: xs[i], y1: 20, x2: xs[i], y2: 340, "data-at": 300 + i * 60 }, host);
    thread.style.transformOrigin = "50% 0";
    // The cue animates CSS transform, which would replace a transform attribute, so the placement sits on a parent group.
    const place = svg("g", { transform: `translate(${xs[i] + 12} 336) rotate(-90)` }, host);
    const label = svg("text", { class: `thread-label cue${root}`, "data-at": 450 + i * 60 }, place);
    label.textContent = name;
  });
  CALLEES.forEach(([, line], index) => {
    const k = index + 1;
    const y = 30 + index * 13;
    const at = 1300 + k * 170;
    svg("line", { class: "weft grow-x", x1: xs[0], y1: y, x2: xs[k], y2: y, "data-at": at }, host);
    svg("rect", { class: "weft-tick cue", x: xs[k] - 1, y: y - 3, width: 3, height: 7, "data-at": at + 200 }, host);
    const number = svg("text", { class: "weft-no cue", x: xs[k] + 5, y: y + 4, "data-at": at + 200 }, host);
    number.textContent = `:${line}`;
  });
}

// Captions arrive word by word, 70 ms apart; a keyword keeps its brass class on each of its words.
function splitCaptions(root) {
  for (const caption of root.querySelectorAll(".cap")) {
    const words = [];
    for (const node of Array.from(caption.childNodes)) {
      const keyword = node.nodeType === Node.ELEMENT_NODE;
      for (const token of (node.textContent ?? "").split(/(?<=\s)/)) {
        if (!token) continue;
        const word = document.createElement("span");
        word.className = keyword ? "w kw" : "w";
        word.textContent = token;
        words.push(word);
      }
    }
    words.forEach((word, i) => word.setAttribute("data-at", String(120 + i * 70)));
    caption.replaceChildren(...words);
  }
}

function setupFilm() {
  const film = document.querySelector("[data-film]");
  if (!film) return;
  const frame = film.querySelector(".film-frame");
  const toggle = film.querySelector("[data-film-toggle]");
  const chipsHost = film.querySelector("[data-film-chips]");
  const progress = film.querySelector("[data-film-progress]");
  const timeOut = film.querySelector("[data-film-time]");
  const countOut = film.querySelector("[data-film-count]");
  const nameOut = film.querySelector("[data-film-name]");

  buildFiles(film.querySelector("[data-files]"));
  buildWeave(film.querySelector("[data-weave]"));
  splitCaptions(film);

  const startOf = (el) => Number(el.closest("[data-start]")?.getAttribute("data-start") ?? 0);
  const scenes = Array.from(film.querySelectorAll(".scene")).map((el) => ({ el, name: el.dataset.scene ?? "", start: Number(el.dataset.start), end: Number(el.dataset.end) }));
  const hosts = Array.from(film.querySelectorAll(".scene, .layer")).map((el) => ({ el, start: Number(el.dataset.start), end: Number(el.dataset.end) }));
  const total = Math.max(...hosts.map((host) => host.end));
  const last = hosts.find((host) => host.end === total && host.el.classList.contains("scene"));
  if (last) last.end = Infinity;
  const cues = Array.from(film.querySelectorAll("[data-at]")).map((el) => ({ el, at: startOf(el) + Number(el.getAttribute("data-at")) }));
  const counters = Array.from(film.querySelectorAll("[data-count]")).map((el) => ({ el, value: Number(el.dataset.count), from: startOf(el) + Number(el.dataset.from), to: startOf(el) + Number(el.dataset.to) }));
  const typers = Array.from(film.querySelectorAll("[data-type]")).map((el) => ({ el, text: el.dataset.type ?? "", from: startOf(el) + Number(el.dataset.typeFrom), to: startOf(el) + Number(el.dataset.typeTo) }));
  const shuttle = film.querySelector("[data-shuttle]");
  const shuttleStart = shuttle ? startOf(shuttle) : 0;

  const chips = scenes.map((scene, i) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.innerHTML = `<span>${String(i + 1).padStart(2, "0")}</span>${scene.name}`;
    chip.addEventListener("click", () => {
      if (reduceMotion.matches) {
        pause();
        seek(i === scenes.length - 1 ? total : scene.end - 1);
      } else {
        seek(scene.start);
        play();
      }
    });
    chipsHost?.append(chip);
    return chip;
  });

  let t = 0;
  let playing = false;
  let autoPaused = false;
  let started = false;
  let lastFrame = 0;
  let raf = 0;

  function render() {
    for (const host of hosts) host.el.classList.toggle("on", t >= host.start && t < host.end);
    for (const cue of cues) cue.el.classList.toggle("on", t >= cue.at);
    for (const counter of counters) {
      const p = clamp01((t - counter.from) / (counter.to - counter.from));
      counter.el.textContent = Math.round(counter.value * (1 - (1 - p) ** 3)).toLocaleString("en-US");
    }
    let typing = false;
    for (const typer of typers) {
      const p = clamp01((t - typer.from) / (typer.to - typer.from));
      typer.el.textContent = typer.text.slice(0, Math.round(typer.text.length * p));
      if (t >= typer.from - 400 && t < typer.to + 500) typing = true;
    }
    film.classList.toggle("typing", typing);
    if (shuttle) {
      const p = clamp01((t - shuttleStart - READ_SWEEP.from) / (READ_SWEEP.to - READ_SWEEP.from));
      shuttle.setAttribute("transform", `translate(${READ_SWEEP.x0 + p * (READ_SWEEP.x1 - READ_SWEEP.x0)} 0)`);
      shuttle.style.opacity = p > 0 && p < 1 ? "1" : "0";
    }
    const index = Math.max(0, scenes.findLastIndex((scene) => t >= scene.start));
    if (progress) progress.style.transform = `scaleX(${t / total})`;
    if (timeOut) timeOut.textContent = `00:${(t / 1000).toFixed(1).padStart(4, "0")}`;
    if (countOut) countOut.textContent = `${String(index + 1).padStart(2, "0")} / ${String(scenes.length).padStart(2, "0")}`;
    if (nameOut) nameOut.textContent = scenes[index]?.name.toLowerCase() ?? "";
    chips.forEach((chip, i) => (i === index ? chip.setAttribute("aria-current", "step") : chip.removeAttribute("aria-current")));
  }

  function label() {
    if (toggle) toggle.textContent = playing ? "Pause" : t >= total ? "Replay" : "Play";
  }

  function frameStep(now) {
    if (!playing) return;
    // Cap the step so a tab that slept does not jump the film forward.
    t = Math.min(total, t + Math.min(100, now - lastFrame));
    lastFrame = now;
    render();
    if (t >= total) {
      playing = false;
      label();
      return;
    }
    raf = window.requestAnimationFrame(frameStep);
  }

  function play() {
    if (t >= total) t = 0;
    playing = true;
    started = true;
    lastFrame = window.performance.now();
    window.cancelAnimationFrame(raf);
    raf = window.requestAnimationFrame(frameStep);
    label();
  }

  function pause() {
    playing = false;
    window.cancelAnimationFrame(raf);
    label();
  }

  function seek(ms) {
    t = Math.min(total, Math.max(0, ms));
    render();
    label();
  }

  toggle?.addEventListener("click", () => {
    autoPaused = false;
    if (playing) pause();
    else play();
  });

  const narrow = window.matchMedia("(max-width: 640px)");
  const fitViewBoxes = () => {
    for (const el of film.querySelectorAll("[data-narrow-viewbox]")) {
      if (!el.dataset.wideViewbox) el.dataset.wideViewbox = el.getAttribute("viewBox") ?? "";
      el.setAttribute("viewBox", narrow.matches ? el.dataset.narrowViewbox ?? "" : el.dataset.wideViewbox);
    }
  };
  narrow.addEventListener("change", fitViewBoxes);
  fitViewBoxes();

  if (reduceMotion.matches) {
    seek(total);
    return;
  }
  seek(0);
  if (!("IntersectionObserver" in window) || !frame) {
    play();
    return;
  }
  // Start when the frame is in view; pause while it is scrolled away, and resume only if the viewer did not pause it.
  new IntersectionObserver((entries) => {
    const visible = entries.some((entry) => entry.isIntersecting);
    if (visible && !started) play();
    else if (visible && autoPaused) {
      autoPaused = false;
      play();
    } else if (!visible && playing) {
      pause();
      autoPaused = true;
    }
  }, { threshold: 0.4 }).observe(frame);
}

function setupReveals() {
  const targets = document.querySelectorAll("[data-reveal]");
  if (!("IntersectionObserver" in window)) {
    targets.forEach((target) => target.classList.add("in"));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.3 });
  targets.forEach((target) => observer.observe(target));
}

function setupTabs() {
  const list = document.querySelector("[data-tabs]");
  if (!list) return;
  const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
  const select = (tab, focus) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(other.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !selected;
    }
    if (!focus) return;
    tab.focus({ preventScroll: true });
    // Scroll only the tab strip; scrollIntoView would also move the page.
    const left = tab.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (left + tab.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = left + tab.offsetWidth - list.clientWidth;
  };
  list.addEventListener("click", (event) => {
    const tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
    if (tab) select(tab, false);
  });
  list.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = tabs[(moves[event.key] + tabs.length) % tabs.length];
    if (next) select(next, true);
  });
  const initial = tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabs[0];
  if (initial) select(initial, false);
}

async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("copy refused");
}

function setupCopy() {
  document.addEventListener("click", async (event) => {
    const button = event.target instanceof Element ? event.target.closest(".copy") : null;
    if (!button) return;
    const targetId = button.getAttribute("data-copy-target");
    const source = targetId ? document.getElementById(targetId) : null;
    const text = button.getAttribute("data-copy") ?? source?.textContent ?? "";
    if (!text) return;
    const label = button.dataset.label ?? button.textContent;
    button.dataset.label = label;
    try {
      await writeClipboard(text);
      button.textContent = "Copied";
      button.classList.add("is-done");
      announce("Copied to the clipboard.");
    } catch {
      button.textContent = "Select and copy";
      announce("The browser blocked the clipboard. Select the text and copy it by hand.");
    }
    window.setTimeout(() => {
      button.textContent = label;
      button.classList.remove("is-done");
    }, 1600);
  });
}

async function showLatestVersion() {
  const slot = document.querySelector("[data-npm-version]");
  if (!slot) return;
  try {
    const response = await fetch("https://registry.npmjs.org/@getdomovoi/osnova/latest", { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const body = await response.json();
    if (typeof body.version === "string" && /^\d+\.\d+\.\d+$/.test(body.version)) slot.textContent = body.version;
  } catch {
    // Keep the version written into the page.
  }
}

buildMark();
setupFilm();
setupReveals();
setupTabs();
setupCopy();
showLatestVersion();
