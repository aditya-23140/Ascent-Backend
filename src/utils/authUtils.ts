import { verifyToken, createClerkClient } from '@clerk/express';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

export async function verifyUserToken(token: string): Promise<{ userId: string; isHardware: boolean } | null> {
  try {
    // 1. Try Clerk Auth (Web)
    try {
      const decoded = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY
      });
      
      if (decoded && decoded.sub) {
        let user = await prisma.user.findUnique({
          where: { clerkId: decoded.sub }
        });

        // If user doesn't exist or is missing email, fetch from Clerk
        if (!user || !user.email) {
          const clerkUser = await clerkClient.users.getUser(decoded.sub);
          const email = clerkUser.emailAddresses[0]?.emailAddress;
          const name = `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim() || clerkUser.username;

          if (!user) {
            user = await prisma.user.create({
              data: { 
                clerkId: decoded.sub,
                email: email,
                name: name
              }
            });
          } else {
            user = await prisma.user.update({
              where: { clerkId: decoded.sub },
              data: { 
                email: email,
                name: name
              }
            });
          }
        }

        return { userId: user.id, isHardware: false };
      }
    } catch (clerkError: any) {
      // Silent fail for Clerk as we check IoT tokens next
    }

    // 2. Try IoT Auth (Device)
    const devices = await prisma.device.findMany();
    for (const device of devices) {
      try {
        const match = await bcrypt.compare(token, device.tokenHash);
        if (match) {
          return { userId: device.userId, isHardware: true };
        }
      } catch (e) {
        // Ignore bcrypt errors
      }
    }

    return null;
  } catch (error: any) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[Auth] Verification error:', error.message);
    }
    return null;
  }
}
