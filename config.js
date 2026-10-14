// Daybreak Wire — client config.
//
// Which backend this page talks to is decided by the HOSTNAME it is served
// from, so a Vercel preview deployment can never write into the live project's
// data by accident. The anon keys are PUBLIC by design (Row Level Security is
// what protects the rows), so committing them is safe.
//
//   language-learning-vert.vercel.app   → PROD    (the real account's data)
//   anything else (previews, localhost) → STAGING (a throwaway project)
//
// STAGING is empty until you fill it in. While it is empty a preview runs in
// LOCAL-ONLY mode: no login bar, nothing leaves the browser. That is the safe
// default — a half-configured preview must not fall back to prod.
(function () {
  var PROD = {
    SUPABASE_URL: "https://icicfqtjvzdyvffbhawt.supabase.co",
    SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImljaWNmcXRqdnpkeXZmZmJoYXd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNTgzODIsImV4cCI6MjA5ODYzNDM4Mn0.mzwD6w4Ky-RKDd7ermeyaUUAuV5CWyRy9Xhog9h5YzM",
  };
  // ↓↓↓ Paste the staging project's Project URL and anon key here to test
  //     sign-in, approval and sync on a preview. Leave empty for local-only.
  var STAGING = {
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
  };

  // The one host that is production. Everything else is treated as a preview.
  var PROD_HOSTS = ["language-learning-vert.vercel.app"];
  var host = (typeof location !== "undefined" && location.hostname) || "";
  var isProd = PROD_HOSTS.indexOf(host) !== -1;
  var backend = isProd ? PROD : STAGING;

  window.DBW_CONFIG = {
    ENV: isProd ? "prod" : "preview",
    SUPABASE_URL: backend.SUPABASE_URL,
    SUPABASE_ANON_KEY: backend.SUPABASE_ANON_KEY,
    GRADE_ENDPOINT: "/api/grade",   // Vercel serverless function; leave as-is
    DEFINE_ENDPOINT: "/api/define", // on-demand meaning for words not in the article glossary
    OVERALL_ENDPOINT: "/api/overall", // overall 총평 + writing-improvement ideas after grading
    DRILL_ENDPOINT: "/api/drill",     // verb/article/plural fill-in-the-blank grammar drills
    ERRMC_ENDPOINT: "/api/errmc",     // multiple-choice distractors for 오답노트 review
  };

  if (!isProd && !backend.SUPABASE_URL) {
    console.info("[Daybreak Wire] preview on " + host + " — local-only (staging backend not configured)");
  }
})();
