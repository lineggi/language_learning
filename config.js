// Daybreak Wire — client config.
// Fill these in after you create your Supabase project. Both values are PUBLIC
// (the anon key is meant to be exposed; Row Level Security protects the data),
// so it is safe to commit them. Leave SUPABASE_URL empty to run in local-only
// mode (no login, data stays in this browser's localStorage).
window.DBW_CONFIG = {
  SUPABASE_URL: "https://icicfqtjvzdyvffbhawt.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImljaWNmcXRqdnpkeXZmZmJoYXd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNTgzODIsImV4cCI6MjA5ODYzNDM4Mn0.mzwD6w4Ky-RKDd7ermeyaUUAuV5CWyRy9Xhog9h5YzM",
  GRADE_ENDPOINT: "/api/grade",   // Vercel serverless function; leave as-is
  DEFINE_ENDPOINT: "/api/define", // on-demand meaning for words not in the article glossary
  OVERALL_ENDPOINT: "/api/overall", // overall 총평 + writing-improvement ideas after grading
};
