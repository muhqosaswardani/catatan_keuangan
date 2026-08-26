let Client;
try {
  Client = require('pg').Client;
} catch (e) {
  Client = require('C:/Users/USER/.gemini/antigravity-ide/brain/74f656db-6827-490a-9741-77a971a18246/scratch/node_modules/pg').Client;
}

const SUPABASE_URL = 'https://qdoduglbejcazjufvfkf.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkb2R1Z2xiZWpjYXpqdWZ2ZmtmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjMyOTE1NCwiZXhwIjoyMTAxOTA1MTU0fQ.OvLIBNGhqbP2ek4TPHqA34RfKjNrob8DfryVDAQZGrs';

async function uploadToStorage(storagePath, buffer, contentType) {
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/chat-ai-images/${encodeURIComponent(storagePath).replace(/%2F/g, '/')}`;
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType || 'image/jpeg',
      'x-upsert': 'true'
    },
    body: buffer
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upload to storage failed (${res.status}): ${errText}`);
  }
  return await res.json();
}

async function main() {
  const connectionStrings = [
    'postgresql://postgres.qdoduglbejcazjufvfkf:rND92kG.%3DR*K_qi@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres',
    'postgresql://postgres:rND92kG.%3DR*K_qi@db.qdoduglbejcazjufvfkf.supabase.co:5432/postgres'
  ];

  let client = null;
  for (const conn of connectionStrings) {
    const c = new Client({
      connectionString: conn,
      ssl: { rejectUnauthorized: false }
    });
    try {
      await c.connect();
      client = c;
      console.log('Connected to DB for backfill via:', conn.split('@')[1]);
      break;
    } catch (err) {
      try { await c.end(); } catch(_) {}
    }
  }

  if (!client) {
    console.error('Failed to connect to database.');
    process.exit(1);
  }

  try {
    const { rows } = await client.query(`
      SELECT user_id, access_code, nav_config
      FROM public.user_settings
      WHERE nav_config IS NOT NULL
        AND jsonb_typeof(nav_config->'chatHistory') = 'array'
    `);

    console.log(`Checking ${rows.length} user_settings records...`);

    let totalBackfilled = 0;

    for (const row of rows) {
      const navConfig = row.nav_config;
      const chatHistory = navConfig.chatHistory;
      if (!Array.isArray(chatHistory)) continue;

      let modified = false;
      const userFolder = row.access_code || (row.user_id ? `wa_${row.user_id}` : `wa_${row.id}`);

      for (let i = 0; i < chatHistory.length; i++) {
        const item = chatHistory[i];
        if (item && item.image && typeof item.image === 'string' && item.image.startsWith('data:image/')) {
          console.log(`Found base64 image in msg ID: ${item.id} (user: ${userFolder})`);

          // Extract mime type and base64 data
          const matches = item.image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
          if (!matches) {
            console.warn(`Could not parse data URL format for msg ID ${item.id}`);
            continue;
          }

          const mimeType = matches[1];
          const base64Data = matches[2];
          let ext = 'jpg';
          if (mimeType.includes('png')) ext = 'png';
          else if (mimeType.includes('webp')) ext = 'webp';

          const buffer = Buffer.from(base64Data, 'base64');
          const fileName = `${item.id || ('msg_' + Date.now() + '_' + i)}.${ext}`;
          const storagePath = `${userFolder}/${fileName}`;

          console.log(`Uploading ${buffer.length} bytes to storage: ${storagePath}...`);
          await uploadToStorage(storagePath, buffer, mimeType);

          // Update image field to storage path
          item.image = storagePath;
          modified = true;
          totalBackfilled++;
        }
      }

      if (modified) {
        console.log(`Saving updated nav_config for user ${row.user_id || row.access_code}...`);
        if (row.user_id) {
          await client.query(
            `UPDATE public.user_settings SET nav_config = $1 WHERE user_id = $2`,
            [JSON.stringify(navConfig), row.user_id]
          );
        } else {
          await client.query(
            `UPDATE public.user_settings SET nav_config = $1 WHERE access_code = $2`,
            [JSON.stringify(navConfig), row.access_code]
          );
        }
      }
    }

    console.log(`\n🎉 Backfill complete! Total images converted & uploaded to Storage: ${totalBackfilled}`);

  } catch (err) {
    console.error('Backfill error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
