/* Contact form — WhatsApp click-to-chat + EmailJS. No Firestore. */
(() => {
  "use strict";

  const WA_NUMBER = "2349016836967";
  const LIMITS = {
    name: 100,
    location: 150,
    email: 254,
    phone: 30,
    service: 150,
    message: 1500,
  };
  const COOLDOWN_MS = 12000;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const form = document.getElementById("contact-form");
  if (!form) return;

  const statusEl = document.getElementById("form-status");
  const submitBtn = document.getElementById("cf-submit");
  const idleLabel = submitBtn ? submitBtn.innerHTML : "Send request";
  let lastSubmitAt = 0;
  let sending = false;

  const clip = (value, max) => String(value || "").trim().slice(0, max);

  const digits = (phone) => phone.replace(/\D/g, "");

  const readFields = () => {
    const data = new FormData(form);
    return {
      name: clip(data.get("name"), LIMITS.name),
      location: clip(data.get("location"), LIMITS.location),
      email: clip(data.get("email"), LIMITS.email),
      phone: clip(data.get("phone"), LIMITS.phone),
      service: clip(data.get("service"), LIMITS.service),
      message: clip(data.get("message"), LIMITS.message),
      method: String(data.get("method") || "whatsapp"),
      company: clip(data.get("company"), 80),
    };
  };

  const validate = (fields) => {
    if (fields.company) return "Please try again.";
    if (!fields.name) return "Please enter your name.";
    if (digits(fields.phone).length < 7) return "Please enter a valid phone number.";
    if (!fields.email || !EMAIL_RE.test(fields.email)) return "Please enter a valid email address.";
    if (!fields.location) return "Please enter your location.";
    if (!fields.service) return "Please choose a service.";
    if (!fields.message) return "Please describe how we can help.";
    if (fields.message.length > LIMITS.message) return "Please keep your message under 1500 characters.";
    if (fields.method !== "whatsapp" && fields.method !== "email") {
      return "Please choose WhatsApp or Email.";
    }
    return "";
  };

  const setStatus = (type, text) => {
    if (!statusEl) return;
    statusEl.hidden = !text;
    statusEl.className = "form-status" + (type ? " is-" + type : "");
    statusEl.textContent = text;
  };

  const setBusy = (busy) => {
    sending = busy;
    if (!submitBtn) return;
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? "Sending…" : "";
    if (!busy) submitBtn.innerHTML = idleLabel;
    if (!busy && window.lucide) lucide.createIcons();
  };

  const buildWhatsAppText = (fields) =>
    [
      "Hello *N.D. Flow Plumbing,*",
      "",
      "I would like to make an enquiry.",
      "",
      "*Name:* " + fields.name,
      "*Location:* " + fields.location,
      "*Phone:* " + fields.phone,
      "*Email:* " + fields.email,
      "*Service:* " + fields.service,
      "",
      "*Message:*",
      fields.message,
      "",
      "Thank you.",
    ].join("\n");

  const openWhatsApp = (fields) => {
    const url =
      "https://wa.me/" + WA_NUMBER + "?text=" + encodeURIComponent(buildWhatsAppText(fields));
    const opened = window.open(url, "_blank", "noopener");
    if (!opened) window.location.href = url;
    setStatus("success", "WhatsApp is opening with your message ready to send.");
  };

  const emailConfigured = () => {
    const cfg = window.ND_FLOW_EMAILJS || {};
    return Boolean(cfg.publicKey && cfg.serviceId && cfg.templateId);
  };

  const sendEmail = async (fields) => {
    if (!emailConfigured()) {
      setStatus(
        "error",
        "Email isn't set up yet. Please choose WhatsApp, or call +234 901 683 6967."
      );
      return;
    }
    if (!window.emailjs) {
      setStatus("error", "We couldn't send your email right now. Please try again or use WhatsApp instead.");
      return;
    }
    const cfg = window.ND_FLOW_EMAILJS;
    await window.emailjs.send(
      cfg.serviceId,
      cfg.templateId,
      {
        from_name: fields.name,
        from_email: fields.email,
        phone: fields.phone,
        location: fields.location,
        service: fields.service,
        message: fields.message,
        subject: "New Website Enquiry - " + fields.service,
      },
      { publicKey: cfg.publicKey }
    );
    setStatus("success", "Your enquiry has been sent successfully.");
    form.reset();
    const wa = form.querySelector('input[name="method"][value="whatsapp"]');
    if (wa) wa.checked = true;
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending) return;

    const now = Date.now();
    if (now - lastSubmitAt < COOLDOWN_MS) {
      setStatus("error", "Please wait a few seconds before sending again.");
      return;
    }

    const fields = readFields();
    const error = validate(fields);
    if (error) {
      setStatus("error", error);
      return;
    }

    lastSubmitAt = now;
    setBusy(true);
    setStatus("", "");

    try {
      if (fields.method === "whatsapp") {
        openWhatsApp(fields);
      } else {
        await sendEmail(fields);
      }
    } catch (err) {
      console.error("Contact form failed:", err);
      if (fields.method === "email") {
        setStatus(
          "error",
          "We couldn't send your email right now. Please try again or use WhatsApp instead."
        );
      } else {
        setStatus("error", "WhatsApp didn't open. Please tap WhatsApp in the footer, or call us.");
      }
    } finally {
      setBusy(false);
    }
  });
})();
