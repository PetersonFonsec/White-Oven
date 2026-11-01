import { useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  ImageBackground,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTheme } from "../brand/theme.tsx";
import { type MenuSection, formatCents } from "../menu/menu.ts";
import { Body, Button, Heading } from "../components/Form.tsx";

export type MenuLoad =
  | { kind: "loading" }
  | { kind: "ok"; sections: MenuSection[] }
  | { kind: "failed" };

interface Props {
  addingDisabled: boolean;
  cart: ReactNode;
  onAddProduct: (id: string) => void;
  storeName: string;
  /** From `menuNotices`: closed, unconfirmed, stale brand or stale menu. */
  notices: string[];
  /** The menu on screen could not be reloaded: the banner offers to try again. */
  menuStale: boolean;
  /** Absolute URL of the brand logo, or null. */
  logoUrl: string | null;
  menu: MenuLoad;
  refreshing: boolean;
  imageUrl: (imageId: string) => string;
  onRetry: () => void;
  onOpenPizza: (flavorId: string) => void;
}

/** Browse the live catalog; category filters and search only shape this local view. */
export function MenuScreen({
  addingDisabled,
  cart,
  onAddProduct,
  storeName,
  notices,
  menuStale,
  logoUrl,
  menu,
  refreshing,
  imageUrl,
  onRetry,
  onOpenPizza,
}: Props) {
  const theme = useTheme();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const sections = menu.kind === "ok" ? menu.sections : [];
  const hero = sections
    .flatMap((section) => section.items)
    .find((item) => item.kind === "PIZZA");
  const visibleSections = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("pt-BR");
    return sections
      .filter((section) => category === "all" || section.id === category)
      .map((section) => ({
        ...section,
        items: section.items.filter(
          (item) =>
            !query ||
            item.name.toLocaleLowerCase("pt-BR").includes(query) ||
            (item.kind === "PIZZA" &&
              item.description?.toLocaleLowerCase("pt-BR").includes(query)),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [category, search, sections]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={{
        paddingHorizontal: theme.spacing(5),
        paddingTop: theme.spacing(4),
        paddingBottom: theme.spacing(6),
        gap: theme.spacing(5),
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: theme.spacing(3),
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: theme.spacing(3),
            flex: 1,
          }}
        >
          {logoUrl ? (
            <Image
              source={{ uri: logoUrl }}
              accessibilityLabel={`Logotipo de ${storeName}`}
              resizeMode="contain"
              style={{ width: 48, height: 48, borderRadius: 14 }}
            />
          ) : (
            <View
              accessible={false}
              style={{
                width: 44,
                height: 44,
                borderRadius: 14,
                backgroundColor: theme.colors.primaryLight,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ fontSize: 22 }}>🍕</Text>
            </View>
          )}
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              numberOfLines={1}
              style={{
                color: theme.colors.text,
                fontSize: theme.typography.title.fontSize,
                lineHeight: theme.typography.title.lineHeight,
                fontWeight: "700",
              }}
            >
              {storeName}
            </Text>
            <Body small muted>
              Cardápio da casa
            </Body>
          </View>
        </View>
        <View style={{ minWidth: 84 }}>{cart}</View>
      </View>

      {notices.length ? (
        <View
          accessibilityRole="alert"
          style={{
            backgroundColor: theme.colors.surfaceSecondary,
            borderRadius: theme.radius.medium,
            borderLeftWidth: 4,
            borderLeftColor: theme.colors.warning,
            padding: theme.spacing(3),
            gap: theme.spacing(1),
          }}
        >
          {notices.map((line) => (
            <Body key={line} small>
              {line}
            </Body>
          ))}
          {menuStale ? (
            <Button
              label={refreshing ? "Atualizando cardápio" : "Atualizar cardápio"}
              loading={refreshing}
              variant="ghost"
              size="small"
              style={{ alignSelf: "flex-start" }}
              onPress={onRetry}
            />
          ) : null}
        </View>
      ) : null}

      <View style={{ gap: theme.spacing(3) }}>
        <Heading level="h1">O que vai pedir hoje?</Heading>
        <Body muted>Escolha seus sabores favoritos.</Body>
      </View>

      {hero && menu.kind === "ok" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Montar ${hero.name}, a partir de ${formatCents(hero.fromCents)}`}
          onPress={() => onOpenPizza(hero.id)}
          style={({ pressed }) => ({
            height: 200,
            overflow: "hidden",
            borderRadius: theme.radius.xl,
            backgroundColor: theme.colors.primaryLight,
            opacity: pressed ? 0.92 : 1,
          })}
        >
          {hero.imageId ? (
            <ImageBackground
              source={{ uri: imageUrl(hero.imageId) }}
              resizeMode="cover"
              style={{ flex: 1, justifyContent: "flex-end" }}
            >
              <View
                style={{
                  padding: theme.spacing(4),
                  backgroundColor: theme.colors.surface,
                  gap: 4,
                }}
              >
                <Body small muted>
                  DESTAQUE DO CARDÁPIO
                </Body>
                <Text
                  style={{
                    color: theme.colors.text,
                    fontSize: theme.typography.h3.fontSize,
                    lineHeight: theme.typography.h3.lineHeight,
                    fontWeight: "700",
                  }}
                >
                  {hero.name}
                </Text>
                <Text
                  style={{
                    color: theme.colors.accentText,
                    fontSize: theme.typography.bodySmall.fontSize,
                    fontWeight: "700",
                  }}
                >
                  A partir de {formatCents(hero.fromCents)} · Montar pizza
                </Text>
              </View>
            </ImageBackground>
          ) : (
            <View
              style={{
                flex: 1,
                padding: theme.spacing(4),
                justifyContent: "center",
                gap: theme.spacing(2),
              }}
            >
              <Body small muted>
                DESTAQUE DO CARDÁPIO
              </Body>
              <Heading level="h2">{hero.name}</Heading>
              <Body>A partir de {formatCents(hero.fromCents)}</Body>
            </View>
          )}
        </Pressable>
      ) : null}

      <View
        style={{
          minHeight: 52,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: theme.spacing(3),
          backgroundColor: theme.colors.surface,
          borderWidth: 1,
          borderColor: theme.colors.inputBorder,
          borderRadius: theme.radius.medium,
          gap: theme.spacing(2),
        }}
      >
        <Text
          accessible={false}
          style={{ color: theme.colors.muted, fontSize: 20 }}
        >
          ⌕
        </Text>
        <TextInput
          accessibilityLabel="Buscar no cardápio"
          placeholder="Buscar pizza ou produto"
          placeholderTextColor={theme.colors.textMuted}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          style={{
            flex: 1,
            minHeight: 50,
            color: theme.colors.text,
            fontSize: 16,
          }}
        />
      </View>

      {sections.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: theme.spacing(2), paddingRight: 4 }}
        >
          {[{ id: "all", name: "Tudo" }, ...sections].map((section) => {
            const selected = category === section.id;
            return (
              <Pressable
                key={section.id}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => setCategory(section.id)}
                style={({ pressed }) => ({
                  minHeight: 44,
                  paddingHorizontal: theme.spacing(4),
                  justifyContent: "center",
                  borderRadius: theme.radius.pill,
                  backgroundColor: selected
                    ? theme.colors.primary
                    : theme.colors.surface,
                  borderWidth: selected ? 0 : 1,
                  borderColor: theme.colors.border,
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <Text
                  style={{
                    color: selected
                      ? theme.colors.onPrimary
                      : theme.colors.text,
                    fontSize: 14,
                    fontWeight: selected ? "700" : "500",
                  }}
                >
                  {section.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {menu.kind === "loading" ? (
        <View
          style={{ paddingVertical: theme.spacing(6), alignItems: "center" }}
        >
          <ActivityIndicator
            accessibilityLabel="Carregando o cardápio"
            color={theme.colors.primary}
            size="large"
          />
          <Body muted>Carregando o cardápio…</Body>
        </View>
      ) : menu.kind === "failed" ? (
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radius.large,
            padding: theme.spacing(5),
            gap: theme.spacing(3),
          }}
        >
          <Heading level="h3">Não foi possível carregar o cardápio</Heading>
          <Body muted>Confira a conexão e tente novamente.</Body>
          <Button
            label="Tentar de novo"
            variant="primary"
            loading={refreshing}
            onPress={onRetry}
          />
        </View>
      ) : sections.length === 0 ? (
        <EmptyMenu />
      ) : visibleSections.length === 0 ? (
        <EmptyMenu searched />
      ) : (
        visibleSections.map((section) => (
          <View key={section.id} style={{ gap: theme.spacing(3) }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Heading level="h2">{section.name}</Heading>
              <Body small muted>
                {section.items.length} itens
              </Body>
            </View>
            {section.items.map((item) => {
              const price =
                item.kind === "PIZZA"
                  ? `A partir de ${formatCents(item.fromCents)}`
                  : formatCents(item.priceCents);
              return (
                <View
                  key={item.id}
                  style={{
                    backgroundColor: theme.colors.surface,
                    borderRadius: theme.radius.large,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    padding: theme.spacing(3),
                    flexDirection: "row",
                    alignItems: "center",
                    gap: theme.spacing(3),
                  }}
                >
                  {item.imageId ? (
                    <Image
                      source={{ uri: imageUrl(item.imageId) }}
                      accessible={false}
                      accessibilityIgnoresInvertColors
                      style={{
                        width: 88,
                        height: 88,
                        borderRadius: theme.radius.medium,
                        backgroundColor: theme.colors.primaryLight,
                      }}
                    />
                  ) : (
                    <View
                      accessible={false}
                      style={{
                        width: 88,
                        height: 88,
                        borderRadius: theme.radius.medium,
                        backgroundColor: theme.colors.primaryLight,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text style={{ fontSize: 32 }}>🍕</Text>
                    </View>
                  )}
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text
                      style={{
                        color: theme.colors.text,
                        fontSize: theme.typography.title.fontSize,
                        lineHeight: theme.typography.title.lineHeight,
                        fontWeight: "700",
                      }}
                    >
                      {item.name}
                    </Text>
                    {item.kind === "PIZZA" && item.description ? (
                      <Text
                        numberOfLines={2}
                        style={{
                          color: theme.colors.textSecondary,
                          fontSize: theme.typography.bodySmall.fontSize,
                          lineHeight: theme.typography.bodySmall.lineHeight,
                        }}
                      >
                        {item.description}
                      </Text>
                    ) : null}
                    <Text
                      style={{
                        color: theme.colors.accentText,
                        fontSize: theme.typography.price.fontSize,
                        lineHeight: theme.typography.price.lineHeight,
                        fontWeight: "700",
                      }}
                    >
                      {price}
                    </Text>
                    {item.kind === "PIZZA" ? (
                      <Button
                        label="Montar pizza"
                        variant="ghost"
                        size="small"
                        style={{ alignSelf: "flex-start", marginLeft: -10 }}
                        onPress={() => onOpenPizza(item.id)}
                      />
                    ) : (
                      <Button
                        label="Adicionar"
                        variant="secondary"
                        size="small"
                        disabled={addingDisabled}
                        accessibilityHint={`Adiciona ${item.name} à sacola`}
                        style={{ alignSelf: "flex-start" }}
                        onPress={() => onAddProduct(item.id)}
                      />
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function EmptyMenu({ searched = false }: { searched?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        padding: theme.spacing(5),
        alignItems: "center",
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.large,
        gap: theme.spacing(2),
      }}
    >
      <Text style={{ fontSize: 32 }}>🍕</Text>
      <Heading level="h3" centered>
        {searched ? "Nenhum resultado" : "Cardápio vazio"}
      </Heading>
      <Body muted centered>
        {searched
          ? "Tente outro termo ou escolha uma categoria diferente."
          : "Esta loja ainda não adicionou produtos ao cardápio."}
      </Body>
    </View>
  );
}
