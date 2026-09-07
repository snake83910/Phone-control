package com.phonecontrol.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Demande de partage d'ecran.
 *
 * Cet ecran est le point ou le chauffeur decide. Trois choix de conception, qui
 * tiennent tous a la meme idee — un accord donne sans comprendre n'est pas un
 * accord :
 *
 * 1. **Le motif est affiche en grand**, tel que l'exploitation l'a ecrit. Pas
 *    resume, pas reformule.
 * 2. **Le demandeur est nomme.** On ne repond pas de la meme facon a
 *    « l'exploitation » qu'a une personne.
 * 3. **Refuser est aussi facile qu'accepter.** Les deux boutons ont la meme
 *    taille et le meme poids visuel. Un bouton de refus discret serait une
 *    facon polie de forcer la main.
 *
 * Ce qui est ecrit ici doit rester vrai : l'ecran de scan n'est jamais partage,
 * et le partage s'arrete tout seul. Ces deux affirmations sont garanties
 * ailleurs — `shouldMaskScreen` et `shouldCapture` — et testees.
 */
@Composable
fun ScreenShareRequestScreen(
    reason: String,
    requestedBy: String,
    busy: Boolean,
    onAccept: () -> Unit,
    onRefuse: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "Partage d’écran demandé",
            fontSize = 30.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onBackground,
        )

        Spacer(Modifier.height(12.dp))

        Text(
            text = if (requestedBy.isBlank()) {
                "Quelqu’un de l’exploitation souhaite voir votre écran."
            } else {
                "$requestedBy souhaite voir votre écran."
            },
            fontSize = 20.sp,
            color = MaterialTheme.colorScheme.onBackground,
        )

        Spacer(Modifier.height(24.dp))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .padding(16.dp),
        ) {
            Text(
                text = "Motif",
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = reason,
                fontSize = 20.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(Modifier.height(24.dp))

        Text(
            text = "Si vous acceptez, votre écran sera visible tant que le " +
                "partage dure. Il s’arrête tout seul, et vous pouvez y mettre " +
                "fin à tout moment. L’écran de lecture des badges n’est jamais " +
                "partagé.",
            fontSize = 16.sp,
            color = MaterialTheme.colorScheme.onBackground,
        )

        Spacer(Modifier.height(32.dp))

        // Deux boutons de meme taille : refuser ne doit pas etre plus difficile
        // qu'accepter.
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(
                onClick = onRefuse,
                enabled = !busy,
                modifier = Modifier
                    .weight(1f)
                    .height(64.dp),
            ) {
                Text("Refuser", fontSize = 20.sp)
            }

            Button(
                onClick = onAccept,
                enabled = !busy,
                modifier = Modifier
                    .weight(1f)
                    .height(64.dp),
            ) {
                Text("Accepter", fontSize = 20.sp)
            }
        }
    }
}

/**
 * Banniere affichee pendant un partage en cours.
 *
 * Android impose deja une notification et son propre indicateur. Celle-ci s'y
 * ajoute plutot qu'elle ne les remplace : elle est visible sans derouler le
 * panneau de notifications, et elle porte l'arret a portee de pouce.
 */
@Composable
fun ScreenShareBanner(
    requestedBy: String,
    onStop: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFFB3261E))
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = if (requestedBy.isBlank()) {
                "Votre écran est partagé"
            } else {
                "Écran partagé avec $requestedBy"
            },
            color = Color.White,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.weight(1f),
        )

        Button(
            onClick = onStop,
            colors = ButtonDefaults.buttonColors(
                containerColor = Color.White,
                contentColor = Color(0xFFB3261E),
            ),
        ) {
            Text("Arrêter", fontSize = 16.sp, fontWeight = FontWeight.Bold)
        }
    }
}
