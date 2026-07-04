import { NextResponse, type NextRequest } from 'next/server';
import { verifySessionCookie } from '@/lib/session';

const publicPaths = ['/login', '/logo-fai.png'];
const cookieName = process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (publicPaths.some((p) => pathname.startsWith(p)) || pathname.startsWith('/_next')) {
    return NextResponse.next();
  }

  const session = await verifySessionCookie(request.cookies.get(cookieName)?.value);
  if (!session) return NextResponse.redirect(new URL('/login', request.url));

  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
