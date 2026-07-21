require('dotenv').config();

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_KEY || '';
const isReal = url && !url.includes('your-project') && key && !key.includes('your_');

if (isReal) {
  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: true } });

  // RLS is enabled on the shared tables — sign in as the app user so queries
  // run as `authenticated`. Anonymous (key-only) access is blocked by policy.
  const email = process.env.SUPABASE_DB_EMAIL;
  const password = process.env.SUPABASE_DB_PASSWORD;
  let signing = null;
  client.__ensureSignedIn = async function ensureSignedIn() {
    if (!email || !password) return;
    const { data } = await client.auth.getSession();
    if (data && data.session) return;
    if (!signing) {
      signing = client.auth
        .signInWithPassword({ email, password })
        .then(({ error }) => {
          if (error) console.error('supabase sign-in failed:', error.message);
        })
        .catch((e) => console.error('supabase sign-in error:', e.message))
        .finally(() => {
          signing = null;
        });
    }
    await signing;
  };
  client.__ensureSignedIn(); // warm up at module load

  module.exports = client;
} else {
  console.log('📁 LOCAL DB MODE — data saved to db/local/*.json');
  module.exports = require('./localdb');
}
