// Data
const PHONE_DISPLAY = "+234 901 683 6967";
const PHONE_HREF = "tel:+2349016836967";

const services = [
  { icon: "wrench", title: "General Plumbing", desc: "Dependable plumbing installation, repair and upkeep for homes and businesses — done right the first time." },
  { icon: "waves", title: "Pipe Installation", desc: "Durable pipe installation and replacement using quality materials and clean, code-compliant workmanship." },
  { icon: "search", title: "Leak Detection & Repair", desc: "Fast, accurate leak detection and permanent repairs — protecting your walls, floors and foundation from hidden damage." },
  { icon: "bath", title: "Bathroom & Kitchen Plumbing", desc: "Complete bathroom and kitchen plumbing — sinks, taps, showers and fittings installed to a clean, lasting finish." },
  { icon: "flame", title: "Water Heater Installation", desc: "Professional water heater installation and servicing, sized correctly and fitted for safe, reliable hot water." },
  { icon: "droplets", title: "Drain Cleaning", desc: "Thorough drain cleaning and unclogging for kitchens, bathrooms and mainlines — fast, with no mess left behind." },
  { icon: "home", title: "Toilet Installation & Repair", desc: "Efficient toilet installation and repair — running, leaking or blocked toilets fixed properly with a lasting seal." },
  { icon: "siren", title: "Emergency Plumbing", desc: "24/7 emergency response for burst pipes, flooding and sudden leaks — we answer the call and get there fast." },
  { icon: "settings", title: "Maintenance Services", desc: "Scheduled plumbing maintenance to catch small issues early — keeping pipes and fixtures running smoothly year-round." },
];

const whyItems = [
  { t: "Professional & courteous", d: "Trained technicians who respect your home or business — clean work, proper tools, no shortcuts." },
  { t: "Clear communication", d: "Honest explanations and upfront pricing before any work begins — no jargon, no surprises." },
  { t: "Fair, transparent pricing", d: "Straightforward quotes agreed before we start, so you always know the cost — no inflated invoices." },
  { t: "Reliable workmanship", d: "Every job is tested and finished to a high standard, backed by our commitment to lasting quality." },
  { t: "Fast response", d: "We show up when we say we will, with rapid dispatch for emergencies — day or night." },
  { t: "Customer satisfaction", d: "Your satisfaction is the job — we're not finished until the work is done right and you're happy." },
];

const gallery = [
  { src: "assets/gallery-pipes.jpg", alt: "Newly installed copper plumbing manifold" },
  { src: "assets/gallery-waterheater.jpg", alt: "Wall-mounted tankless water heater installation" },
  { src: "assets/gallery-shower.jpg", alt: "Modern walk-in shower installation" },
  { src: "assets/gallery-drain.jpg", alt: "Professional drain camera inspection" },
];

const reviews = [
  { name: "Chidinma A.", city: "Homeowner", stars: 5, text: "Called them for a burst pipe emergency and they arrived within the hour. Professional, honest, and the work has held up perfectly." },
  { name: "Emeka O.", city: "Business Owner", stars: 5, text: "N.D. Flow handled the plumbing for our new office fit-out. On schedule, tidy work, and they explained every step clearly." },
  { name: "Ifeoma B.", city: "Estate Resident", stars: 5, text: "Finally a plumbing company that turns up on time and does the job right the first time. Highly recommend." },
  { name: "Tunde K.", city: "Property Manager", stars: 5, text: "We use them for maintenance across several properties. Reliable, fair pricing, and always reachable when something urgent comes up." },
];

const areas = ["Residential Homes","Apartments & Flats","Commercial Offices","Retail Shops","Estates & Gated Communities","New Developments","Hotels & Shortlets","Schools & Institutions","Places of Worship"];

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

// Who we serve
document.getElementById("areas-list").innerHTML = areas.map(a => `
  <li>${iconTag("check","icon-sm")} ${escape(a)}</li>
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
