package com.phonecontrol.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Enrôlement manuel.
 *
 * **Écran de mise en service, pas d'usage courant.** En production, le jeton
 * arrive par le QR code de provisioning et cet écran n'apparaît jamais : le
 * téléphone est déjà enrôlé quand le premier chauffeur le prend en main.
 *
 * Il existe pour la Phase 4, où il est le seul moyen de valider la chaîne
 * complète sur un terminal de test avant que le Device Owner ne soit en place.
 */
@Composable
fun EnrollmentScreen(
    defaultServerUrl: String,
    busy: Boolean,
    error: String?,
    onEnroll: (token: String, serverUrl: String) -> Unit,
) {
    var token by remember { mutableStateOf("") }
    var serverUrl by remember { mutableStateOf(defaultServerUrl) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "MISE EN SERVICE",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(8.dp))

        Text(
            text = "Ce téléphone n'est pas encore rattaché à une entreprise.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            fontSize = 15.sp,
        )

        Spacer(Modifier.height(28.dp))

        OutlinedTextField(
            value = serverUrl,
            onValueChange = { serverUrl = it },
            label = { Text("Adresse du serveur") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(16.dp))

        OutlinedTextField(
            value = token,
            onValueChange = { token = it.uppercase() },
            label = { Text("Jeton d'enrôlement") },
            placeholder = { Text("ETK-XXXXXXXX-XXXXXXXX") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Characters,
            ),
            modifier = Modifier.fillMaxWidth(),
        )

        error?.let {
            Spacer(Modifier.height(16.dp))
            Text(
                text = it,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
                fontSize = 15.sp,
            )
        }

        Spacer(Modifier.height(28.dp))

        Button(
            onClick = { onEnroll(token, serverUrl) },
            enabled = !busy && token.length >= 8,
            modifier = Modifier.fillMaxWidth().height(60.dp),
        ) {
            Text(if (busy) "Enrôlement…" else "ENRÔLER CE TÉLÉPHONE", fontSize = 18.sp)
        }

        Spacer(Modifier.height(24.dp))

        Text(
            text = "Le jeton est généré depuis le dashboard, sur la fiche du " +
                "téléphone. Il est à usage unique.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            fontSize = 13.sp,
        )
    }
}
