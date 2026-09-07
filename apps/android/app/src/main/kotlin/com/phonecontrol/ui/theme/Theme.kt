package com.phonecontrol.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Palette de l'application embarquee.
 *
 * Elle est volontairement sombre et tres contrastee : l'ecran est lu dans une
 * cabine, souvent en plein soleil ou de nuit, par quelqu'un qui tient un badge
 * d'une main. Les couleurs ne servent qu'a l'etat — vert autorise, rouge
 * refuse — jamais a la decoration.
 */
private val Ink = Color(0xFFE2E8F0)
private val InkMuted = Color(0xFF94A3B8)
private val Surface = Color(0xFF0B1120)
private val SurfaceRaised = Color(0xFF111A2E)
private val Accent = Color(0xFF60A5FA)
private val Ok = Color(0xFF34D399)
private val Danger = Color(0xFFF87171)

private val DarkColors = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF061224),
    secondary = Ok,
    error = Danger,
    background = Surface,
    onBackground = Ink,
    surface = Surface,
    onSurface = Ink,
    surfaceVariant = SurfaceRaised,
    onSurfaceVariant = InkMuted,
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF1D4ED8),
    secondary = Color(0xFF047857),
    error = Color(0xFFB91C1C),
)

private val AppTypography = Typography(
    // Les titres de l'ecran verrouille doivent etre lisibles a bout de bras.
    displaySmall = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.Bold),
    headlineMedium = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 18.sp),
)

@Composable
fun PhoneControlTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = AppTypography,
        content = content,
    )
}
