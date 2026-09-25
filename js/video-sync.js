const DATE = "2026-09-17";
const MAP = "data/dail-2026-09-17-openai/video-map.json";
const STREAM = "https://media.heanet.ie/m3u8/16ea7b8d7be04c46ad664b6299e24121";

function mount(map) {
  if (document.getElementById("videoSync")) return;
  const panel = document.createElement("aside"); panel.id = "videoSync";
  panel.innerHTML = `<div class="vs-head"><div><strong>Watch this debate</strong><span>Video-linked edition</span></div><label class="vs-follow"><input id="vsFollow" type="checkbox" checked> Follow text</label></div><video id="vsVideo" controls playsinline preload="metadata" aria-label="Dáil Éireann sitting video"></video><p id="vsStatus" aria-live="polite">Select a highlighted paragraph to play from that point.</p>`;
  document.body.append(panel);
  const video = panel.querySelector("video"), follow = panel.querySelector("input"), status = panel.querySelector("p");
  video.src = STREAM;
  const entries = map.paragraphs.sort((a,b)=>a.start-b.start);
  const lookup = id => entries.find(x=>x.id===id);
  document.querySelectorAll(".speech p[id]").forEach(p => {
    const entry=lookup(p.id); if(!entry) return;
    p.classList.add("vs-mapped"); p.title="Play from this paragraph";
    p.addEventListener("click", e => { if(e.target.closest("a")) return; video.currentTime=entry.start; video.play().catch(()=>{}); });
  });
  let active;
  video.addEventListener("timeupdate", () => {
    const t=video.currentTime; let lo=0,hi=entries.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(entries[mid].start<=t)lo=mid+1;else hi=mid;}
    const next=entries[lo-1]; if(!next || t>next.end+15) return;
    if(active?.id===next.id) return; active?.classList.remove("vs-active");
    active=document.getElementById(next.id); active?.classList.add("vs-active"); status.textContent=`Now reading: ${next.speaker}`;
    if(follow.checked) active?.scrollIntoView({block:"center",behavior:"smooth"});
  });
}
document.addEventListener("debate-rendered", async e => { if(e.detail.date!==DATE) return; try { mount(await fetch(MAP).then(r=>r.json())); } catch(e) { console.warn("Video map unavailable",e); } });
