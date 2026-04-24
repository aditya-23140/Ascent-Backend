import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation Error',
      details: err.errors
    });
  }

  // Handle specific timer conflicts (409)
  if (err.status === 409 || err.message?.includes('conflict')) {
    return res.status(409).json({
      error: 'Conflict',
      message: err.message
    });
  }

  console.error('Server Error:', err);
  res.status(res.statusCode === 200 ? 500 : res.statusCode).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? undefined : err.message
  });
};
