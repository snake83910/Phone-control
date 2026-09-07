# kotlinx.serialization : les serialiseurs sont generes, R8 ne doit pas les voir
# comme inutilises.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class com.phonecontrol.** {
    *** Companion;
}
-keepclasseswithmembers class com.phonecontrol.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Le recepteur d'administration de l'appareil est instancie par le systeme.
-keep class com.phonecontrol.kiosk.** { *; }

# Aucun journal en release (docs/07 §5).
#
# R8 supprime les appels a android.util.Log dont le resultat n'est pas utilise.
# La raison n'est pas la taille du binaire : un logcat de production finit
# toujours par etre lu par quelqu'un, et il ne doit rien contenir qui aide a
# retrouver un chauffeur ou un badge. Les erreurs, elles, sont conservees :
# c'est ce qui reste pour diagnostiquer un terminal qui rentre au depot.
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
    public static int w(...);
}

# SQLCipher : le pont JNI est appele par nom depuis le code natif.
-keep class net.zetetic.database.** { *; }
-keep class net.sqlcipher.** { *; }
