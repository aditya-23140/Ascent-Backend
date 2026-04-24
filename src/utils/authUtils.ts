import { createClerkClient } from '@clerk/clerk-sdk-node';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';

if (!process.env.CLERK_SECRET_KEY) {
  console.warn('WARNING: CLERK_SECRET_KEY is not set in environment variables at module load time.');
}

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

export async function verifyUserToken(token: string): Promise<{ userId: string; isHardware: boolean } | null> {
  try {
    // 1. Try Clerk Auth (Web)
    try {
      const decoded = await clerk.verifyToken(token);
      if (decoded && decoded.sub) {
        let user = await prisma.user.findUnique({
          where: { clerkId: decoded.sub }
        });

        if (!user) {
          user = await prisma.user.create({
            data: { clerkId: decoded.sub }
          });
        }

        return { userId: user.id, isHardware: false };
      }
    } catch (clerkError: any) {
      console.warn(`[Auth] Clerk verification failed: ${clerkError.message}`);
      // Proceed to IoT check
    }

    // 2. Try IoT Auth (Device)
    const devices = await prisma.device.findMany();
    for (const device of devices) {
      const match = await bcrypt.compare(token, device.tokenHash);
      if (match) {
        return { userId: device.userId, isHardware: true };
      }
    }

    return null;
  } catch (error: any) {
    console.error('[Auth] Database error during verification:', error);
    if (error.code) console.error(`[Auth] Error Code: ${error.code}`);
    return null;
  }
}
