import { NextResponse, type NextRequest } from 'next/server';
const publicPaths = ['/login'];
export function middleware(request: NextRequest) { const { pathname } = request.nextUrl; if (publicPaths.some((p) => pathname.startsWith(p)) || pathname.startsWith('/_next')) return NextResponse.next(); const cookie = request.cookies.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session'); if (!cookie) return NextResponse.redirect(new URL('/login', request.url)); return NextResponse.next(); }
export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
