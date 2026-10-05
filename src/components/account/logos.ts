// Official marks: Google and Yandex from Wikimedia Commons, Microsoft from its Entra branding guide.
import googleLogo from "../../assets/providers/google.svg";
import yandexLogo from "../../assets/providers/yandex.svg";
import microsoftLogo from "../../assets/providers/microsoft.svg";
import type { OAuthProvider } from "../../lib/types";

export const PROVIDER_LOGO: Record<OAuthProvider, string> = { google: googleLogo, yandex: yandexLogo, microsoft: microsoftLogo };
