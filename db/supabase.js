require('dotenv').config();

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_KEY || '';
const isReal = url && !url.includes('your-project') && key && !key.includes('your_');

if (isReal) {
  const { createClient } = require('@supabase/supabase-js');
  module.exports = createClient(url, key);
} else {
  console.log('📁 LOCAL DB MODE — data saved to db/local/*.json');
  module.exports = require('./localdb');
}
