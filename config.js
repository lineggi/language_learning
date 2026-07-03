// Daybreak Wire — client config.
// Fill these in after you create your Supabase project. Both values are PUBLIC
// (the anon key is meant to be exposed; Row Level Security protects the data),
// so it is safe to commit them. Leave SUPABASE_URL empty to run in local-only
// mode (no login, data stays in this browser's localStorage).
window.DBW_CONFIG = {
  SUPABASE_URL: "https://icicfqtjvzdyvffbhawt.supabase.co",
  SUPABASE_ANON_KEY: "",         // Supabase → Project Settings → API → "anon public" key (paste here)
  GRADE_ENDPOINT: "/api/grade",  // Vercel serverless function; leave as-is
};
