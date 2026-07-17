// Data
const PHONE_DISPLAY = "(903) 555-0100";
const PHONE_HREF = "tel:+19035550100";

const services = [
  { icon: "waves", title: "Sewer Repair", desc: "Trenchless-friendly sewer line diagnosis, repair and replacement done right the first time." },
  { icon: "droplets", title: "Drain Cleaning", desc: "Fast, thorough drain clearing for kitchens, baths, and main lines — no mess left behind." },
  { icon: "search", title: "Leak Detection", desc: "Non-invasive leak location using acoustic and thermal tools to pinpoint hidden water loss." },
  { icon: "wrench", title: "Leak Repair", desc: "Permanent fixes for slab, wall, and fixture leaks — sealed, tested, and warrantied." },
  { icon: "hammer", title: "Pipe Repair", desc: "Copper, PEX and PVC repair and re-piping with clean, code-compliant workmanship." },
  { icon: "home", title: "Toilet Installation", desc: "Efficient, quiet, comfort-height toilets professionally set with a lasting seal." },
  { icon: "wrench", title: "Toilet Repair", desc: "Running, leaking, or clogged? We diagnose and repair every make and model." },
  { icon: "shower-head", title: "Shower Installation", desc: "Full shower systems, valves and pans installed to spec — no callbacks." },
  { icon: "shower-head", title: "Shower Repair", desc: "Valve replacements, pan repairs and pressure fixes with clean, tidy work." },
  { icon: "flame", title: "Water Heater Installation", desc: "Tank & tankless installation sized for your home, permitted and pressure-tested." },
  { icon: "flame", title: "Water Heater Repair", desc: "Same-day diagnosis on pilots, elements, thermostats and leaks." },
  { icon: "container", title: "Water Tank Installation", desc: "Well pressure tanks and storage tanks installed with the right fittings and controls." },
  { icon: "container", title: "Water Tank Repair", desc: "Bladder, fitting and pressure switch service to keep your water supply steady." },
  { icon: "hammer", title: "New Construction Plumbing", desc: "Ground-up rough-ins and finish work for builders and remodelers. On time, on plan." },
];

const whyItems = [
  { t: "Professional service", d: "Uniformed technicians, drop cloths down, boots off — treated like your home, not a job site." },
  { t: "Clear communication", d: "Upfront quotes, honest recommendations, and a phone number that a real person answers." },
  { t: "Fair pricing", d: "Flat-rate pricing on most repairs so you know the cost before we start. No surprise invoices." },
  { t: "Reliable workmanship", d: "Every job is pressure-tested, code-compliant, and backed by a written workmanship warranty." },
  { t: "Fast response", d: "Same-day emergency response across Kemp and the Cedar Creek Lake area, 24 hours a day." },
  { t: "Customer satisfaction", d: "We're not done until you're happy — that's why our neighbors keep sending us their friends." },
];

const gallery = [
  { src: "assets/gallery-pipes.jpg", alt: "Newly installed copper plumbing manifold" },
  { src: "assets/gallery-waterheater.jpg", alt: "Wall-mounted tankless water heater installation" },
  { src: "assets/gallery-shower.jpg", alt: "Modern walk-in shower installation" },
  { src: "assets/gallery-drain.jpg", alt: "Professional drain camera inspection" },
];

const reviews = [
  { name: "Sarah M.", city: "Kemp, TX", stars: 5, text: "Came out the same evening for a burst pipe. Clean, professional, fair price. They saved our floors." },
  { name: "David R.", city: "Mabank, TX", stars: 5, text: "Installed a new tankless water heater in one day. Explained everything, cleaned up better than they found it." },
  { name: "Jennifer P.", city: "Gun Barrel City, TX", stars: 5, text: "Finally a plumber that shows up when they say they will. Diagnosed a slab leak two others missed." },
  { name: "Marcus T.", city: "Seven Points, TX", stars: 5, text: "Fair quote, no upsells, quality work. Roughed in the plumbing for our new build without a hitch." },
];

const areas = ["Kemp","Mabank","Gun Barrel City","Seven Points","Athens","Malakoff","Eustace","Cedar Creek Lake","Tool","Payne Springs"];

const escape = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iconTag = (name, cls="icon") => `<i data-lucide="${name}" class="${cls}"></i>`;

// Render services
document.getElementById("services-grid").innerHTML = services.map(s => `
  <article class="service-card">
    <div class="s-icon">${iconTag(s.icon)}</div>
    <h3>${escape(s.title)}</h3>
    <p>${escape(s.desc)}</p>
    <a href="${PHONE_HREF}" class="req">Request service ${iconTag("arrow-right","icon-sm")}</a>
  </article>
`).join("");

// Why us
document.getElementById("why-list").innerHTML = whyItems.map(i => `
  <li class="why-item">
    <div class="head">
      <span class="badge">${iconTag("check","icon-sm")}</span>
      <h3>${escape(i.t)}</h3>
    </div>
    <p>${escape(i.d)}</p>
  </li>
`).join("");

// Gallery
document.getElementById("gallery-grid").innerHTML = gallery.map((g,i) => `
  <figure class="gallery-fig ${i===0?"large":"small"}">
    <img src="${g.src}" alt="${escape(g.alt)}" loading="lazy" width="1200" height="900" />
  </figure>
`).join("");

// Reviews
document.getElementById("reviews-grid").innerHTML = reviews.map(r => `
  <figure class="review">
    <div class="stars">${Array.from({length:r.stars}).map(()=>iconTag("star","icon-sm")).join("")}</div>
    <blockquote>“${escape(r.text)}”</blockquote>
    <figcaption>
      <span class="avatar">${escape(r.name[0])}</span>
      <span>
        <span class="name">${escape(r.name)}</span>
        <span class="city">${escape(r.city)}</span>
      </span>
    </figcaption>
  </figure>
`).join("");

// Areas
document.getElementById("areas-list").innerHTML = areas.map(a => `
  <li>${iconTag("map-pin","icon-sm")} ${escape(a)}, TX</li>
`).join("");

// Mobile menu
const toggle = document.getElementById("menu-toggle");
const mobileNav = document.getElementById("mobile-nav");
toggle.addEventListener("click", () => {
  const open = mobileNav.classList.toggle("open");
  toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  toggle.innerHTML = open ? iconTag("x") : iconTag("menu");
  if (window.lucide) lucide.createIcons();
});
mobileNav.querySelectorAll("a").forEach(a => a.addEventListener("click", () => {
  mobileNav.classList.remove("open");
  toggle.innerHTML = iconTag("menu");
  if (window.lucide) lucide.createIcons();
}));

// Contact form
const form = document.getElementById("contact-form");
const formWrap = document.getElementById("contact-form-wrap");
form.addEventListener("submit", (e) => {
  e.preventDefault();
  formWrap.innerHTML = `
    <div class="form-success">
      <div class="check">${iconTag("check")}</div>
      <h3>Request received</h3>
      <p>Thanks — we'll call you back shortly. For emergencies, please call
        <a href="${PHONE_HREF}">${PHONE_DISPLAY}</a>.</p>
    </div>`;
  if (window.lucide) lucide.createIcons();
});

// Footer year
document.getElementById("year").textContent = new Date().getFullYear();

// Initialize icons
if (window.lucide) lucide.createIcons();
