// contact-live.js
// Writes contact requests to Firestore `messages` so they aren't lost on submit.
import { db } from "./firebase-config.js";
import {
  collection,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const PHONE_DISPLAY = "+234 901 683 6967";
const PHONE_HREF = "tel:+2349016836967";

const form = document.getElementById("contact-form");
const formWrap = document.getElementById("contact-form-wrap");
if (!form || !formWrap) {
  // Not on the contact page.
} else {
  const submitBtn = form.querySelector('button[type="submit"]');

  function iconTag(name, cls = "icon") {
    return `<i data-lucide="${name}" class="${cls}"></i>`;
  }

  function showSuccess() {
    formWrap.innerHTML = `
      <div class="form-success">
        <div class="check">${iconTag("check")}</div>
        <h3>Request received</h3>
        <p>Thanks — we'll call you back shortly. For emergencies, please call
          <a href="${PHONE_HREF}">${PHONE_DISPLAY}</a>.</p>
      </div>`;
    if (window.lucide) lucide.createIcons();
  }

  function showError(text) {
    let banner = form.querySelector(".form-error-banner");
    if (!banner) {
      banner = document.createElement("p");
      banner.className = "form-error-banner";
      banner.setAttribute("role", "alert");
      form.insertBefore(banner, form.firstChild);
    }
    banner.textContent = text;
    if (submitBtn) submitBtn.disabled = false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitBtn) submitBtn.disabled = true;

    const data = new FormData(form);
    const payload = {
      name: String(data.get("name") || "").trim(),
      phone: String(data.get("phone") || "").trim(),
      email: String(data.get("email") || "").trim(),
      address: String(data.get("address") || "").trim(),
      message: String(data.get("message") || "").trim(),
      source: "contact.html",
      createdAt: serverTimestamp(),
    };

    if (!payload.name || !payload.phone || !payload.message) {
      showError("Please fill in your name, phone, and a short description.");
      return;
    }

    try {
      await addDoc(collection(db, "messages"), payload);
      showSuccess();
    } catch (error) {
      console.error("Contact form failed:", error);
      showError("Couldn't send that just now. Please call or WhatsApp us instead.");
    }
  });
}
