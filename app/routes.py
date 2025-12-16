import logging
import os
from fastapi import Request, APIRouter, HTTPException, Depends, Form
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from jose import JWTError, jwt
from app.services import get_llm_generations

logger = logging.getLogger(__name__)
router = APIRouter()
templates = Jinja2Templates(directory="templates")

# JWT Configuration
SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM = os.getenv("ALGORITHM", "HS256")
ACCESS_TOKEN = os.getenv("ACCESS_TOKEN", "access_token")
COOKIE_DOMAIN = os.getenv("COOKIE_DOMAIN")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
COOKIE_SAMESITE = os.getenv("COOKIE_SAMESITE", "lax")

# Validate SECRET_KEY
if not SECRET_KEY:
    raise ValueError("SECRET_KEY environment variable is required but not set!")

logger.info(f"Analytics Service - JWT Config: Algorithm={ALGORITHM}, Cookie Domain={COOKIE_DOMAIN}")
logger.info(f"SECRET_KEY loaded: Yes")


async def get_current_user(request: Request):
    """Verify JWT from cookie or Authorization header"""
    logger.info(f"Auth attempt from {request.client.host} for {request.url.path}")
    logger.info(f"Cookies present: {list(request.cookies.keys())}")

    # Try to get token from cookie
    token = request.cookies.get(ACCESS_TOKEN)
    if token:
        logger.info(f"Token found in cookie: {ACCESS_TOKEN}")
    else:
        logger.warning(f"No token found in cookie: {ACCESS_TOKEN}")

    # Try Authorization header if no cookie
    if not token:
        auth_header = request.headers.get("Authorization")
        if auth_header:
            if auth_header.startswith("Bearer "):
                token = auth_header.replace("Bearer ", "")
                logger.info("Token found in Authorization header")
            else:
                logger.warning("Invalid Authorization header format")
        else:
            logger.warning("No Authorization header present")

    if not token:
        logger.error(f"Authentication failed: No token provided from {request.client.host}")
        raise HTTPException(status_code=401, detail="No token provided")

    try:
        # Decode token
        logger.info("Attempting to decode token with SECRET_KEY")
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("sub")
        user_id = payload.get("id")

        logger.info(f"Token decoded successfully: user_id={user_id}, email={email}")

        if not email or not user_id:
            logger.error(f"Invalid token payload: email={email}, user_id={user_id}")
            raise HTTPException(status_code=401, detail="Invalid token payload")

        logger.info(f"User authenticated successfully: {email} (ID: {user_id})")
        return {"email": email, "id": user_id}

    except JWTError as e:
        logger.error(f"JWT validation failed: {type(e).__name__}: {str(e)}")
        raise HTTPException(status_code=401, detail=f"Invalid or expired token: {str(e)}")
    except Exception as e:
        logger.error(f"Unexpected error during authentication: {type(e).__name__}: {str(e)}")
        raise HTTPException(status_code=401, detail="Authentication error")


@router.post("/auth")
async def authenticate(
        request: Request,
        token: str = Form(...),
        user_id: int = Form(...)
):
    """Receive JWT token from auth service, validate it, and set cookie"""
    logger.info("=" * 60)
    logger.info("AUTH ENDPOINT CALLED - Analytics Service")
    logger.info("=" * 60)
    logger.info(f"Received token for user_id: {user_id}")
    logger.info(f"Token (first 30 chars): {token[:30] if token else 'NO TOKEN'}...")

    try:
        # Decode and validate the token
        logger.info(f"Decoding with SECRET_KEY: {SECRET_KEY[:10]}... Algorithm: {ALGORITHM}")
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        decoded_email = payload.get("sub")
        decoded_user_id = payload.get("id")

        logger.info(f"Token decoded: email={decoded_email}, user_id={decoded_user_id}")

        # Verify the user_id matches
        if decoded_user_id != user_id:
            logger.error(f"User ID mismatch: expected={user_id}, got={decoded_user_id}")
            raise HTTPException(status_code=400, detail="User ID mismatch")

        logger.info(f"User {decoded_email} (ID: {decoded_user_id}) authenticated successfully")

        # Create response with redirect to service home
        response = RedirectResponse(url="/", status_code=303)

        # Set cookie with the JWT token
        cookie_params = {
            "key": ACCESS_TOKEN,
            "value": token,
            "httponly": True,
            "secure": COOKIE_SECURE,
            "samesite": COOKIE_SAMESITE,
            "path": "/"
        }

        if COOKIE_DOMAIN:
            cookie_params["domain"] = COOKIE_DOMAIN
            logger.info(f"Setting cookie with domain: {COOKIE_DOMAIN}")
        else:
            logger.info("Setting cookie without domain (localhost)")

        logger.info(f"Cookie params: {cookie_params}")
        response.set_cookie(**cookie_params)
        logger.info(f"Cookie set for user {decoded_user_id}, redirecting to homepage")

        return response

    except JWTError as e:
        logger.error(f"Invalid token received: {type(e).__name__}: {str(e)}")
        raise HTTPException(status_code=401, detail=f"Invalid token: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Authentication failed with error: {type(e).__name__}: {str(e)}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Authentication failed")


@router.get("/", response_class=HTMLResponse)
async def dashboard(
        request: Request,
        user: dict = Depends(get_current_user)
):
    """Dashboard - requires authentication"""
    logger.info(f"Dashboard accessed by user {user['id']} ({user['email']})")
    return templates.TemplateResponse("index.html", {
        "request": request,
        "user": user
    })


@router.get("/api/traces")
async def get_traces(
        request: Request,
        user: dict = Depends(get_current_user)
):
    """API traces - requires authentication"""
    logger.info(f"API traces requested by user {user['id']}: {request.query_params}")

    limit_str = request.query_params.get("limit", "20")

    # Input validation
    try:
        limit = int(limit_str)
        limit = max(1, min(limit, 200))
    except (ValueError, TypeError):
        limit = 20
        logger.warning(f"Invalid limit '{limit_str}', using default 20")

    items = get_llm_generations(limit)

    # Handle error responses
    if items and isinstance(items, list) and len(items) > 0:
        if isinstance(items[0], dict) and "error" in items[0]:
            logger.error(f"API error response: {items[0]['error']}")
            raise HTTPException(status_code=503, detail=items[0]["error"])

    logger.info(f"Returning {len(items)} traces to user {user['id']}")
    return items
