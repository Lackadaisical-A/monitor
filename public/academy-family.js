"use strict";
(() => {
  const token = location.hash.slice(1);
  const status = document.getElementById("status"), entries = document.getElementById("entries"), refresh = document.getElementById("refresh");
  const earlier = document.getElementById("earlier");
  const photos = new Set(); let generation = 0, nextOffset = null;
  const waiting = new Map();
  const observer = new IntersectionObserver(items => { for (const item of items) if (item.isIntersecting) { observer.unobserve(item.target); const start = waiting.get(item.target); waiting.delete(item.target); if (start) start(); } }, { rootMargin: "200px" });
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
  async function request(path) {
    const response = await fetch(`/api/academy/v1/family/${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(response.status === 401 ? "This link is unavailable. Ask your instructor for a current family link." : "Updates could not be loaded. Check your connection and try again.");
    return response;
  }
  async function load(append = false) {
    if (!append) {
      generation++; entries.replaceChildren(); observer.disconnect(); waiting.clear();
      for (const url of photos) URL.revokeObjectURL(url); photos.clear();
      document.getElementById("student-heading").textContent = "See what takes flight.";
    }
    const version = generation;
    refresh.disabled = true; earlier.disabled = true; earlier.hidden = true;
    status.textContent = "Opening your private logbook…";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { status.textContent = "Open the private family link your instructor shared with you."; refresh.disabled = false; return; }
    try {
      const data = await (await request(`journal?offset=${append ? nextOffset : 0}`)).json();
      document.getElementById("student-heading").textContent = `${data.studentName}'s journey.`;
      document.getElementById("intro").textContent = "Discover what they accomplished in class, see their work, and look ahead to what's next.";
      status.textContent = data.entries.length ? "" : "Their next chapter is on its way. Shared class updates will appear here.";
      nextOffset = data.nextOffset; earlier.hidden = nextOffset === null;
      for (const entry of data.entries) {
        const article = node("article", "", "entry"), meta = node("div", "", "entry-meta");
        const date = new Date(`${entry.classDate}T12:00:00`);
        const time = node("time", date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })); time.dateTime = entry.classDate;
        meta.append(time, node("span", String(entry.course))); article.append(meta, node("h3", entry.title), node("p", entry.accomplishments));
        if (entry.nextSteps) { const next = node("div", "", "next"); next.append(node("h4", "Up next"), node("p", entry.nextSteps)); article.append(next); }
        if (entry.photoIDs.length) {
          const grid = node("div", "", "photos"); article.append(grid);
          for (const [index, id] of entry.photoIDs.entries()) {
            const figure = node("figure", "", "photo"), caption = node("figcaption", "Loading photo…"); figure.append(caption); grid.append(figure);
            // Blob URLs avoid putting the family credential in image request URLs.
            waiting.set(figure, () => { void request(`photos/${encodeURIComponent(id)}`).then(response => response.blob()).then(blob => {
              if (version !== generation) return;
              const url = URL.createObjectURL(blob); photos.add(url);
              const image = node("img"); image.src = url; image.alt = `Class accomplishment photo ${index + 1}`; image.loading = "lazy";
              figure.replaceChildren(image);
            }).catch(() => { if (version === generation) caption.textContent = "Photo unavailable. Refresh to try again."; }); });
            observer.observe(figure);
          }
        }
        entries.append(article);
      }
    } catch (error) { status.textContent = error.message; }
    finally { refresh.disabled = false; earlier.disabled = false; }
  }
  refresh.addEventListener("click", () => load());
  earlier.addEventListener("click", () => load(true));
  // A returning tab rechecks revocation instead of displaying a stale family feed.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void load(); });
  void load();
})();
