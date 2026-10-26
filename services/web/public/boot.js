(() => {
  if (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true || new URLSearchParams(location.search).get("source") === "android") document.documentElement.classList.add("installed-app");
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); window.fomopadInstallPrompt = e; window.dispatchEvent(new Event("fomopad:installready")); });
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

  const screen = document.getElementById("bootScreen");
  const skip = document.getElementById("bootSkip");
  const shell = document.querySelector(".app-shell");
  const track = document.getElementById("bootProgressTrack");
  const fill = document.getElementById("bootProgressFill");
  const status = document.getElementById("bootStatus");
  const stage = document.getElementById("bootStage");
  const scene = stage?.querySelector(".boot-scene");
  if (!screen || !skip || !shell || !track || !fill || !status) return;
  const started = performance.now();
  const minimum = 5200;
  let ready = false, requested = false, finished = false, timedOut = false;
  let ticker;
  function progress(value) {
    const percent = Math.min(100, Math.round(value));
    fill.style.width = percent + "%";
    track.setAttribute("aria-valuenow", String(percent));
  }
  function enter() {
    if (finished) return;
    finished = true;
    clearInterval(ticker);
    progress(100);
    screen.classList.add("is-leaving");
    shell.removeAttribute("inert");
    document.body.classList.remove("booting");
    if (screen.contains(document.activeElement)) document.querySelector(".brand")?.focus();
    setTimeout(() => screen.remove(), 450);
  }
  if (stage && scene && !matchMedia("(prefers-reduced-motion: reduce)").matches && !matchMedia("(max-width: 760px)").matches) {
    let motionFrame = 0;
    stage.addEventListener("pointermove", e => {
      const rect = stage.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - .5;
      const y = (e.clientY - rect.top) / rect.height - .5;
      cancelAnimationFrame(motionFrame);
      motionFrame = requestAnimationFrame(() => {
        scene.style.setProperty("--tilt-x", (-y * 11).toFixed(2) + "deg");
        scene.style.setProperty("--tilt-y", (x * 12).toFixed(2) + "deg");
      });
    });
    stage.addEventListener("pointerleave", () => {
      cancelAnimationFrame(motionFrame);
      scene.style.setProperty("--tilt-x", "0deg");
      scene.style.setProperty("--tilt-y", "0deg");
    });
  }
  skip.addEventListener("click", () => {
    if (timedOut && !ready) { location.reload(); return; }
    requested = true;
    if (ready) enter();
    else { skip.textContent = "Opening site…"; status.textContent = "Preparing the launch board…"; }
  });
  screen.addEventListener("keydown", e => { if (e.key === "Escape" && ready) enter(); });
  window.addEventListener("fomopad:ready", () => {
    ready = true;
    if (requested) enter();
  }, { once: true });
  ticker = setInterval(() => {
    if (finished) return;
    const elapsed = performance.now() - started;
    progress(Math.min(92, elapsed / minimum * 92));
    if (ready && elapsed >= minimum) enter();
    if (elapsed > 12000 && !ready && !timedOut) {
      timedOut = true;
      clearInterval(ticker);
      status.textContent = "Still loading. Try again when you're ready.";
      skip.textContent = "Retry loading ↻";
    }
  }, 100);
})();