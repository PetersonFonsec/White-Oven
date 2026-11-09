import { validSlug } from "./core/api/public-api";
import { type Routes } from "@angular/router";
export const routes: Routes = [
  {
    path: "",
    pathMatch: "full",
    title: "Encontre sua pizzaria · WhiteOven",
    loadComponent: () =>
      import("./features/entry.page").then((m) => m.EntryPage),
  },
  {
    path: "lojas/:storeSlug",
    canMatch: [(_route, segments) => validSlug(segments[1]?.path ?? "")],
    loadComponent: () =>
      import("./layout/store-shell").then((m) => m.StoreShell),
    children: [
      {
        path: "",
        pathMatch: "full",
        title: "Sua pizzaria",
        loadComponent: () =>
          import("./features/store.page").then((m) => m.StorePage),
      },
      {
        path: "cardapio",
        title: "Cardápio",
        loadComponent: () =>
          import("./features/catalog/catalog.page").then((m) => m.CatalogPage),
      },
      {
        path: "montar/:flavorId",
        title: "Monte sua pizza",
        loadComponent: () =>
          import("./features/builder/builder.page").then((m) => m.BuilderPage),
      },
      {
        path: "sacola",
        title: "Sacola",
        loadComponent: () =>
          import("./features/cart/cart.page").then((m) => m.CartPage),
      },
      {
        path: "checkout",
        title: "Checkout",
        loadComponent: () =>
          import("./features/cart/checkout.page").then((m) => m.CheckoutPage),
      },
      {
        path: "conta",
        title: "Minha conta",
        data: { mode: "login" },
        loadComponent: () =>
          import("./features/account/account.page").then((m) => m.AccountPage),
      },
      {
        path: "cadastro",
        title: "Criar conta",
        data: { mode: "register" },
        loadComponent: () =>
          import("./features/account/account.page").then((m) => m.AccountPage),
      },
      {
        path: "recuperar-acesso",
        title: "Recuperar acesso",
        data: { mode: "recovery" },
        loadComponent: () =>
          import("./features/account/account.page").then((m) => m.AccountPage),
      },
      {
        path: "verificacao",
        title: "Verificação de e-mail",
        data: { mode: "verification" },
        loadComponent: () =>
          import("./features/account/account.page").then((m) => m.AccountPage),
      },
      {
        path: "pedidos",
        title: "Meus pedidos",
        loadComponent: () =>
          import("./features/orders/orders.page").then((m) => m.OrdersPage),
      },
      {
        path: "pedidos/:orderId",
        title: "Detalhes do pedido",
        loadComponent: () =>
          import("./features/orders/orders.page").then((m) => m.OrdersPage),
      },
      {
        path: "informacoes",
        title: "Informações da loja",
        loadComponent: () =>
          import("./features/information.page").then((m) => m.InformationPage),
      },
      {
        path: "**",
        title: "Página não encontrada",
        loadComponent: () =>
          import("./features/not-found.page").then((m) => m.NotFoundPage),
      },
    ],
  },
  {
    path: "**",
    title: "Página não encontrada",
    loadComponent: () =>
      import("./features/not-found.page").then((m) => m.NotFoundPage),
  },
];
