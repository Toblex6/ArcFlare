import { registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function register() {
  const dirPath = path.resolve(process.cwd(), 'recovery');

  // Create directory if it doesn't exist
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath);
  }

  console.log('🔒 Registering Entity Secret with Circle...');

  try {
    const response = await registerEntitySecretCiphertext({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
      recoveryFileDownloadPath: dirPath, // Pointing to the folder
    });

    console.log('✅ Success! Secret registered.');
    console.log(`💾 Recovery file saved inside: ${dirPath}`);
  } catch (error: any) {
    console.error('🔴 Registration failed:', error.message || error);
  }
}

register();
