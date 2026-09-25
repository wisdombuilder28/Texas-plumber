/* Public contact settings only — never put a private / secret key here.

   1. businessEmail  — required for the Email option (same idea as the
      portfolio mailto). Put the client's real inbox here.
   2. EmailJS keys   — optional. If all three are filled, the site sends
      the enquiry directly (visitor does not open their mail app).
      Public key only. Never a private key. */
window.ND_FLOW_EMAILJS = {
  businessEmail: "",
  publicKey: "",
  serviceId: "",
  templateId: "",
};
