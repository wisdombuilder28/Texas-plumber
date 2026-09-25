/* Contact form — WhatsApp click-to-chat + Email (mailto / optional EmailJS). */
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
  const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

  const form = document.getElementById("contact-form");
  if (!form) return;

  const statusEl = document.getElementById("form-status");
  const submitBtn = document.getElementById("cf-submit");
  let lastSubmitAt = 0;
  let sending = false;

  const clean = (value, max) =>
    String(value || "")
      .replace(CTRL, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);

  const cleanMultiline = (value, max) =>
    String(value || "")
      .replace(CTRL, "")
      .replace(/\r\n?/g, "\n")
      .trim()
      .slice(0, max);

  const digits = (phone) => phone.replace(/\D/g, "");

  const cfg = () => window.ND_FLOW_EMAILJS || {};

  const businessEmail = () => {
    const raw = String(cfg().businessEmail || "").trim();
    return EMAIL_RE.test(raw) ? raw : "";
  };

  const emailjsReady = () => {
    const c = cfg();
    return Boolean(c.publicKey && c.serviceId && c.templateId && window.emailjs);
  };

  const readFields = () => {
    const data = new FormData(form);
    return {
      name: clean(data.get("name"), LIMITS.name),
      location: clean(data.get("location"), LIMITS.location),
      email: clean(data.get("email"), LIMITS.email).toLowerCase(),
      phone: clean(data.get("phone"), LIMITS.phone),
      service: clean(data.get("service"), LIMITS.service),
      message: cleanMultiline(data.get("message"), LIMITS.message),
      method: String(data.get("method") || "whatsapp"),
      company: clean(data.get("company"), 80),
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
    submitBtn.textContent = busy ? "Sending…" : "Send request";
  };

  const enquiryLines = (fields) => [
    "Hello N.D. Flow Plumbing,",
    "",
    "I would like to make an enquiry.",
    "",
    "Name: " + fields.name,
    "Location: " + fields.location,
    "Phone: " + fields.phone,
    "Email: " + fields.email,
    "Service: " + fields.service,
    "",
    "Message:",
    fields.message,
    "",
    "Thank you.",
  ];

  const openWhatsApp = (fields) => {
    const url =
      "https://wa.me/" + WA_NUMBER + "?text=" + encodeURIComponent(enquiryLines(fields).join("\n"));
    const opened = window.open(url, "_blank", "noopener");
    if (!opened) window.location.href = url;
    setStatus("success", "WhatsApp is opening with your message ready to send.");
  };

  const openMailApp = (fields) => {
    const to = businessEmail();
    if (!to) {
      setStatus(
        "error",
        "Email isn't set up yet. Please choose WhatsApp, or call +234 901 683 6967."
      );
      return false;
    }
    const subject = ("New Website Enquiry - " + fields.service).slice(0, 120);
    const body = enquiryLines(fields).join("\n");
    const mailto =
      "mailto:" +
      encodeURIComponent(to) +
      "?subject=" +
      encodeURIComponent(subject) +
      "&body=" +
      encodeURIComponent(body);
    const gmail =
      "https://mail.google.com/mail/?view=cm&fs=1&tf=1&to=" +
      encodeURIComponent(to) +
      "&su=" +
      encodeURIComponent(subject) +
      "&body=" +
      encodeURIComponent(body);

    window.location.href = mailto;
    window.setTimeout(() => {
      if (document.hasFocus()) {
        window.open(gmail, "_blank", "noopener");
      }
    }, 650);
    setStatus("success", "Your email app is opening with your message ready to send.");
    return true;
  };

  const sendViaEmailJs = async (fields) => {
    const c = cfg();
    await window.emailjs.send(
      c.serviceId,
      c.templateId,
      {
        from_name: fields.name,
        from_email: fields.email,
        phone: fields.phone,
        location: fields.location,
        service: fields.service,
        message: fields.message,
        subject: "New Website Enquiry - " + fields.service,
      },
      { publicKey: c.publicKey }
    );
    setStatus("success", "Your enquiry has been sent successfully.");
    form.reset();
    const wa = form.querySelector('input[name="method"][value="whatsapp"]');
    if (wa) wa.checked = true;
  };

  const sendEmail = async (fields) => {
    if (emailjsReady()) {
      await sendViaEmailJs(fields);
      return;
    }
    openMailApp(fields);
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
        const opened = openMailApp(fields);
        if (!opened) {
          setStatus(
            "error",
            "We couldn't send your email right now. Please try again or use WhatsApp instead."
          );
        }
      } else {
        setStatus("error", "WhatsApp didn't open. Please tap WhatsApp in the footer, or call us.");
      }
    } finally {
      setBusy(false);
    }
  });
})();
