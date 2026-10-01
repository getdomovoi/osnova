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

function setupStage() {
  const stage = document.querySelector("[data-stage]");
  const replay = document.querySelector("[data-replay]");
  if (!stage) return;
  if (reduceMotion.matches || !("IntersectionObserver" in window)) {
    if (replay) replay.hidden = true;
    return;
  }
  const play = () => {
    stage.classList.remove("play");
    void stage.offsetWidth;
    stage.classList.add("play");
  };
  stage.classList.add("armed");
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      observer.disconnect();
      play();
    }
  }, { threshold: 0, rootMargin: "0px 0px -15% 0px" });
  observer.observe(stage.querySelector(".stage-grid") ?? stage);
  if (replay) replay.addEventListener("click", play);
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
setupStage();
setupReveals();
setupTabs();
setupCopy();
showLatestVersion();
