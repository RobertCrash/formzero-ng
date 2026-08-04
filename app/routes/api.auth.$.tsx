import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import {
    claimInstanceOwner,
    getAuth,
    getUserCount,
    releaseInstanceOwnerClaim,
} from '#/lib/auth.server'

const SIGNUP_DISABLED = data({
    success: false,
    message: "An account already exists. Please login instead.",
    error: "SIGNUP_DISABLED",
}, { status: 403 })

/** Best effort, for the audit trail only: an unreadable body is not fatal. */
async function readSignupEmail(request: Request) {
    try {
        const body = await request.clone().json<{ email?: unknown }>()
        return typeof body.email === "string" ? body.email : null
    } catch {
        return null
    }
}

async function handleAuthRequest(request: Request, context: any) {
    const database = context.cloudflare.env.DB
    const auth = getAuth({ database })
    const url = new URL(request.url)

    if (url.pathname.includes('/sign-up/email') && request.method === 'POST') {
        // Fast path with the friendlier message; the claim below is the guard
        // that actually holds under concurrent requests.
        if (await getUserCount({ database }) > 0) return SIGNUP_DISABLED

        const claimed = await claimInstanceOwner({
            database,
            email: await readSignupEmail(request),
        })
        if (!claimed) return SIGNUP_DISABLED

        const response = await auth.handler(request)
        if (!response.ok) {
            // A rejected sign-up (weak password, duplicate email) must not leave
            // the instance permanently unclaimable.
            await releaseInstanceOwnerClaim({ database })
        }
        return response
    }

    return auth.handler(request)
}

export async function loader({ request, context }: LoaderFunctionArgs) {
    return handleAuthRequest(request, context)
}

export async function action({ request, context }: ActionFunctionArgs) {
    return handleAuthRequest(request, context)
}
