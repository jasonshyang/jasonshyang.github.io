---
layout: post
title: UniswapV3 Liquidity Model
date: 2025-01-29
categories: [DeFi]
tags: [dex, uniswap]
---
This article provides a mathematic explanation of UniswapV3 liquidity model outlined in the UniswapV3 Whitepaper.

---

## Introduction

There are many great resources on the internet explaining the UniswapV3 liquidity model, the [Whitepaper](https://app.uniswap.org/whitepaper-v3.pdf) here obviously is the golden source.

While the V3 Whitepaper offers a great walk through on their design, I think there are still concepts that could benefit from further explanation, especially around the mathematic relationships between different equations, and how the Uniswap team arrives at this conclusions.

Our goal here is do a deep dive into the UniswapV3 liquidity model, and provide the necessary mathematical explanations.

## Liquidity Concentration

**Concentrated Liquidity** is the idea that a liquidity provider (LP) can 'concentrate' their liquidity within a specific price range to improve capital-efficiency.

The V3 Whitepaper calls this the 'defining idea of Uniswap V3', as many of the V2 to V3 changes are directly or indirectly driven by this idea.

> The defining idea of Uniswap v3 is that of concentrated liquidity: liquidity bounded within some price range.
> In earlier versions, liquidity was distributed uniformly along the reserves curve, where 𝑥 and 𝑦 are the respective reserves of two assets X and Y, and 𝑘 is a constant. In other words, earlier versions were designed to provide liquidity across the entire price range (0, ∞).

### What does 'provide liquidity across (0, ∞)' mean?
Before we dive into V3, let's first understand this statement:
> earlier versions were designed to provide liquidity across the entire price range (0, ∞).

We might wonder what does providing liquidity across entire price range really means.

V2 liquidity model is very simple, using a **Constant Product Formula** $x * y = k$. While this is simple to implement, it implicitly means X (the reserve of token0) and Y (the reserve of token1) can take any non-zero numbers, and we know that $Y/X$ is the price, so it means the price can range from (0, ∞).

What this really means is, we can trade at any price point with a V2 pool, if we start from $Y/X=1$, we could keep swapping in token0 (so X increases), and get less and less token1 back (as price drops), and do this in an infinite loop.

While this could make sense for trading some of the extremely volatile pairs, it certainly does not make sense for majority of pairs.

### How do we concentrate liquidity?
While conceptually it makes sense to concentrate the price range from (0, ∞) to (a, b), how do we actually do this while still preserving the Automated Market Making mechanisms offered in V2?

To understand this, the key is understanding *Virtual Reserves* vs *Real Reserves*. 

Let's first look at how the Uniswap team explains this:
> A position only needs to maintain enough reserves to support trading within its range, and therefore can act like a constant product pool with larger reserves (we call these the virtual reserves) within that range.
> Specifically, a position only needs to hold enough of asset X to cover price movement to its upper bound, because upwards price movement corresponds to depletion of the X reserves

Figure 2 in the Whitepaper provides a virtualization of the two curves
![img](https://raw.githubusercontent.com/jasonshyang/jasonshyang.github.io/refs/heads/main/assets/img/posts/uniswapv3.png)

Here we have two curves:
- *Virtual Reserves*: $x_{vir} * y_{vir} = L^2$
- *Real Reserves*: $(x_{real} + offset_0) * (y_{real} + offset_1) = L^2$

We shift the *Virtual Reserves* curve to *Real Reserves* curve by introducing the $offset_0$ and $offset_1$ constants (both are higher than zero). We will do the math to calculate them later, for now let's focus on the property of our liquidity curve after introducing these two offsets.

Firstly, we notice that the *Virtual Reserves* curve is essentially a Uniswap V2 curve. This is an interesting property, because we can derive that if we reduce our offsets here, we will make these two curve getting close to each other (we will revisit this point when we go through the math to derive the offsets).

We also notice that $\Delta x_{real}$ and $\Delta y_{real}$ have similar relationship like the **Constant Product Formula** as long as none of them are zero: if we swap in token0 (so $x_{real}$ increases by $\Delta x_{real}$), to make the product constant, we can predict the swap out amount in token1.

Last but not the least, comparing these two curves, we notice that, by introducing the offsets here, we are essentially allowing X and Y to take the value of 0:
- if we are using the V2 curve $x * y = k$, and we know $k \neq 0$, this means both X and Y cannot be 0
- but if we are using the V3 curve (i.e. the *Real Reserves* curve) above, we can allow X or Y to be 0 because of the offsets

This is a huge step! Remember earlier we discussed that V2 trades on price range (0, ∞) because we cannot have zero reserves? Now that we can allow $x = 0$ or $y = 0$, we effectively allow the price to range from (a, b), so we are **concentrating** the liquidity provided by LPs!

### What is the capital efficiency improvement?
Before we dive deeper into the calculation, let's take a step back to understand why we say V3 has better capital efficiency.

Intuitively, it is not hard to understand: by concentrating the liquidity to a price range, we improved efficiency. But what does 'efficiency' mean here?

We know liquidity provider (LP) makes a profit primarily through fees, so the capital efficiency is essentially, how much fees LP can get by providing the same liquidity.

Now let's prove, to facilitate the same trade (so same fee), V3 needs less reserves:

- In V2, we know $(x_{v2} + x_{in}) * (y_{v2} - y_{out}) = L^2$, so essentially we need $x_{v2}$ and $y_{v2}$ reserve for a trade that swap in $x_{in}$ for $y_{out}$. 
- In V3, we know the same applies on our virtual reserves curve, $(x_{vir} + x_{in}) * (y_{vir} - y_{out}) = L^2$, so we need $x_{vir}$ and $y_{vir}$ virtual reserves for the same trade, so we have $x_{v2} = x_{vir}$ and same for y.
- Because we know $(x_{real} + offset_0) = x_{vir}$, and $(y_{real} + offset_1) = y_{vir}$, and we know $offset_0$ and $offset_1$ both are higher than zero, we can derive that $x_{real} < x_{vir} = x_{v2}$ and same for y.

Because the *Real Reserves* is what LP provides, we can now identify the efficiency improvement: **V3 pool requires less liquidity to facilitate trade, as long as the trade is within the price range specified**. The trade off here is: if the trade goes outside of the price range, we provides no liquidity so no trade can be made.

so the word 'concentration' is very accurate here!

## Liquidity Model

Now that we understand the mechanism for liquidity concentration, let's dive into calculating and completing our formulas to what the Uniswap team has written in the V3 Whitepaper.

We will start from the *Real Reserves* curve we had in the last section, and then move on to calculating when price goes outside of our price range.

### Calculating offsets
First we want to calculate our offset0 and offset1:
$(x_{real} + offset_0) * (y_{real} + offset_1) = L^2$

We know the answer from the V3 Whitepaper already.
> $(x + \frac{L}{\sqrt{p_b}})(y + L\sqrt{p_a}) = L^2$

But to better understand it, let's calculate it ourselves!

Before proceeding, we need to define a couple of important variables:

- $Liquidity: L = \sqrt{x_{vir}} * \sqrt{y_{vir}}$

- $Price: p = y_{vir} / x_{vir}$

- $Price Range: (p_a, p_b)$

Ok, now let's start from calculating our $offset_0$.

When our pool has no token0 (so $x_{real} = 0$), we know we hit our upper price cap $p_a$ (so $p = p_b$). So here our liquidity curve can be simplified to the below:

$(offset_0) * (y_{real} + offset_1) = L^2$

Using the definition of L and p above, we can derive:

$x_{vir} = y_{vir} / p_b$

$x_{vir} = L^2 / y_{vir}$

$y_{vir} / p_b = L^2 / y_{vir}$

$y_{vir}^2 = L^2 * p_b$

$y_{vir} = L * \sqrt{p_b}$

We also know: $y_{real} + offset_1 = y_{vir}$

If we plug these into our liquidity curve above:

$(offset_0) * (y_{real} + offset_1) = L^2$

$(offset_0) * y_{vir} = L^2$

$(offset_0) * L * \sqrt{p_b} = L^2$

$offset_0 = L / \sqrt{p_b}$

We can do the same for $offset_1$ where we make $y_{real}=0$ and we know price will be $p=p_a$ as we run out of token1 reserves, so our price should hit our lower range:

$y_{vir} = x_{vir} * p_a$

$y_{vir} = L^2 / x_{vir}$

$x_{vir} * p_a = L^2 / x_{vir}$

$x_{vir} = L / \sqrt{p_a}$

$offset_1 * x_{vir} = L^2$

$offset_1 * L / \sqrt{p_a} = L^2$

$offset_1 = L * \sqrt{p_a}$

Now we can plug our offset0 and offset1 back to our formula:

$(x_{real} + L / \sqrt{p_b}) * (y_{real} + L * \sqrt{p_a}) = L^2$

This is exactly the same as the liquidity curve written in Uniswap V3, nice!

This formula offers more insights into the relationship between our price range (a, b) and our *Virtual* and *Real* Reserves curves. Remember we touched on this earlier that: when we reduces our offsets, these two curves will get closer and closer to each other? Let's see if we can mathematically prove it.

If we make our price range (0, ∞), so we have $p_a=0$, and $p_b=∞$. Let's plug them in our formula:

$(x_{real} + L / \sqrt{∞}) * (y_{real} + L * \sqrt{0}) = L^2$

$L / \sqrt{∞}$ is close to 0, $L * \sqrt{0}$ is 0, so our formula becomes:

$x_{real} * y_{real} = L^2$

We are back to *Virtual Reserves* curve!

### Calculating amount required to provide liquidity
To calculate how much token0 and token1 is required when providing liquidity to V3 pool at a given price point P, we need to understand we are providing liquidity to a price range, not to the entire curve. 

This means, depends on whether current price P is in our range, our liquidity equation will be different.

Note: in this article we will not cover the ticking part, which has been explained in great detail in the V3 Whitepaper already.

Again, let's go back to the V3 Whitepaper and look at the answer:

$$
\Delta Y =
\begin{cases}
0 & \text{if } i_c < i_l \\
\Delta L \cdot \left( \sqrt{P} - \frac{p}{p(i_l)} \right) & \text{if } i_l \leq i_c < i_u \\
\Delta L \cdot \left( \frac{p}{p(i_u)} - \frac{p}{p(i_l)} \right) & \text{if } i_c \geq i_u
\end{cases}
$$
$$
\Delta X =
\begin{cases}
\Delta L \cdot \left( \sqrt{\frac{1}{p(i_l)}} - \sqrt{\frac{1}{p(i_u)}} \right) & \text{if } i_c < i_l \\
\Delta L \cdot \left( \frac{1}{\sqrt{P}} - \sqrt{\frac{1}{p(i_u)}} \right) & \text{if } i_l \leq i_c < i_u \\
0 & \text{if } i_c \geq i_u
\end{cases}
$$

Wow, ok, there's a lot going on here, and the Whitepaper only says:
>These formulas can be derived from formulas 6.14 and 6.16, and depend on whether the current price is below, within, or above the range of the position

So let's see if we can derive these ourselves! 

But before we start, I would recommend to read [Atis Elsts' Liquidity Math in Uniswap V3](https://atiselsts.github.io/pdfs/uniswap-v3-liquidity-math.pdf) which covers a lot of the works already.

My main contribution here would be to offer my interpretations, especially on where $p_a < P < p_b$. In Atis' paper, it was explained in this way:
> I believe the way to think about it is to consider that in an optimal position both assets are going to contribute to the liquidity equally. 

Where I believe there is a mathematic way to directly derive this instead of using the above reasoning. 

But before we get there, let's start from the others parts first (as they are easier).

**1. If $P \leq P_a$:**

This is where our current price point is below our price range, in this case, as an LP, we don't need to provide any token1 reserves.

Conceptually we can look at it in this way: because we are only interested in providing liquidity only when price goes up and getting into our price range, and we know this needs swappers to swap in token1 for token0 which increases P. When price enters our range, at the tipping point, the trade would be to swap in more token1 for token0 (which is the liquidity we provide). And after the price gets into our range, naturally we will have reserves in token1 (provided by the swapper!).

So here we know $\Delta y_{real} = 0$, easy!

To calculate $\Delta X$, we can use a similar approach we did when calculating offsets, let's look at our liquidity curve formula once again:

$(x_{real} + L / \sqrt{p_b}) * (y_{real} + L * \sqrt{p_a}) = L^2$

Because we know there is no token1 reserves, so $y_{real} = 0$, and we can derive the following:

$(x_{real} + L / \sqrt{p_b}) * L * \sqrt{p_a} = L^2$

$(x_{real} + L / \sqrt{p_b}) * \sqrt{p_a} = L$

$x_{real} = L / \sqrt{p_a} - L / \sqrt{p_b}$

$x_{real} = L * (1 / \sqrt{p_a} - 1 / \sqrt{p_b})$

$\Delta x_{real} = \Delta L * (1 / \sqrt{p_a} - 1 / \sqrt{p_b})$

**2. If $P \geq P_b$:**

We can use the exact same thought process to do this part:

$\Delta x_{real} = 0$

$L / \sqrt{p_b} * (y_{real} + L * \sqrt{p_a}) = L^2$

$y_{real} = L * \sqrt{p_b} - L * \sqrt{p_a}$

$y_{real} = L (\sqrt{p_b} - \sqrt{p_a})$

$\Delta y_{real} = \Delta L (\sqrt{p_b} - \sqrt{p_a})$

Ok so far this is straightforward!

**3. If $p_a < P < p_b$:**

Now this is the most tricky part, as our liquidity curve formula has 3 moving parts: $x_{real}$, $y_{real}$, $L$. When providing liquidity, both reserves change and so does our liquidity L.

$(x_{real} + L / \sqrt{p_b}) * (y_{real} + L * \sqrt{p_a}) = L^2$

Our goal here is to figure out the relationship between $x_{real}$ and $L$, $y_{real}$ and $L$. To do this, we will need to discover further relationships between these.

[Atis Elsts' Liquidity Math in Uniswap V3](https://atiselsts.github.io/pdfs/uniswap-v3-liquidity-math.pdf) offers a way to look at this by thinking there is an optimal position where both tokens contribute same liquidity, and then solving the $L_x = L_y$ problem.

Here we try to provide another way to explain this. 

There is one important property we know from UniswapV2: when providing liquidity, the price does not change. The UniswapV2 contract provide incentives for LPs to maintain the price by taking the minimum of token0 and token1 provided (adjusted by weight) in the `mint` function:
```solidity
liquidity = Math.min(amount0.mul(_totalSupply) / _reserve0, amount1.mul(_totalSupply) / _reserve1);
```

Building on this property of a constant price when providing liquidity, we can now start deriving this:

$x_{vir} * y_{vir} = L^2$

$P = y_{vir} / x_{vir}$

$y_{vir} = L * \sqrt{P}$

And we also know:

$y_{vir} = y_{real} + L * \sqrt{p_a}$

Now we can connect them together:

$L * \sqrt{P} = y_{real} + L * \sqrt{p_a}$

$y_{real} = L * (\sqrt{P} - \sqrt{p_a})$

Because we know P is a constant here, we have:

$\Delta y_{real} = \Delta L * (\sqrt{P} - \sqrt{p_a})$

Using the same approach we can calculate:

$\Delta x_{real} = \Delta L * (1 / \sqrt{P} - 1 / \sqrt{p_b})$

Finally, we have derived all three parts for $\Delta X$ and $\Delta Y$ 

## Conclusion

UniswapV3 allows Liquidity Providers to concentrate their liquidity to improve capital efficiency, this is done by creating a *Real Reserves* curve that only provide liquidity for swapping within a given price range. When trading within the range, the trade behaves like a UniswapV2 curve and follows the Constant Product Formula.

We have gone through the mathematics behind these this to derive our liquidity curve equation, and used this to understand the underlying property of UniswapV3 Liquidity Model.