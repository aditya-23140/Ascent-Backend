import { Request, Response, NextFunction } from 'express';
import { verifyUserToken } from '../utils/authUtils';

export interface AuthRequest extends Request {
  userId?: string;
  isHardware?: boolean;
}

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }

  const result = await verifyUserToken(token);
  if (result) {
    req.userId = result.userId;
    req.isHardware = result.isHardware;
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
};
