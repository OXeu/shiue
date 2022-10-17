---
title: "Jetpack Compose ViewPager 滑动手感优化"
date: 2022-02-12T11:28:52+08:00
draft: false
description: 与Jetpack Compose相关联的伴生库Accompanist提供了一些Android必要的,但是Compose基本库没提供的控件,比如ViewPager、SwipeRefreshLayout等
slug: compose-fling
image: cover2.jpg
categories:
- 开发
tags:
- Compose
- Android
---
> 封面来源 [Watching-Sunset](https://www.deviantart.com/bisbiswas/art/Watching-Sunset-929518803)

与Jetpack Compose相关联的伴生库Accompanist提供了一些Android必要的,但是Compose基本库没提供的控件,比如ViewPager、SwipeRefreshLayout等

其中默认的 ViewPager Fling手感(快速滑动松手后的惯性运动效果)相较于原生 ViewPager 特别奇怪，尤其是速度够快时能够同时滑过多个页面，且Fling滑到边界时还会有边缘效果(边缘水波纹效果)，就像约束过小导致刹不住车一样，而原生ViewPager不存在这种情况。因此我参考ViewPager相关滑动源码及[Jetpack Compose实现类似Viewpager滚动 - dikeboyR - 博客园 (cnblogs.com)](https://www.cnblogs.com/dikeboy/p/15256819.html)进行改造，实现了与原生ViewPager Fling手感完全一致的Fling效果，且避免了由于

PagerState.currentPage延迟更新或打断动画而导致的错误判断

```Kotlin
import androidx.compose.animation.core.animate
import androidx.compose.animation.rememberSplineBasedDecay
import androidx.compose.foundation.gestures.FlingBehavior
import androidx.compose.foundation.gestures.ScrollScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.google.accompanist.pager.ExperimentalPagerApi
import com.google.accompanist.pager.PagerState
import kotlin.math.abs
import kotlin.math.sign

@OptIn(ExperimentalPagerApi::class)
@Composable
fun pagerFlingBehavior(state: PagerState): FlingBehavior {
    val flingSpec = rememberSplineBasedDecay<Float>()
        return remember(flingSpec) {
            PagerFling(state)
            }
            }

@ExperimentalPagerApi
class PagerFling(
val state: PagerState
) : FlingBehavior {
    private val childWidth = width()//Pager页面宽度，这里用屏幕宽度代替
    override suspend fun ScrollScope.performFling(initialVelocity: Float): Float {
        return if (abs(initialVelocity) >= 0f) {
            val stOffset = state.currentPageOffset - state.currentPageOffset.toInt()// 减去 offset 整数部分
            val targetPosition = determineTargetPage(
            stOffset,
            initialVelocity
            ) // 计算目标页面
            val destValue: Float = (targetPosition - stOffset) * childWidth // 根据目标页面计算动画偏移的目标像素
            var deltaX: Float // 剩余速度,由大到小
            var startPos = 0f // 开始位置
            // 执行动画
            animate(0f, destValue, 0f) { value, _ ->
                // value 从 0f -> destValue 由大到小分成有限块
                deltaX = value - startPos
                scrollBy(deltaX) // 滚动位移差
                startPos = value // 设置开始位置
                }
                0f
                } else {
                    initialVelocity
                    }
                    }
                    }

// 最小 Fling Offset 距离常数,单位:像素,从 ViewPager 复制而来
private const val MIN_DISTANCE_FOR_FLING = 25 // dips
// 最小 Fling Velocity 速度常数,从 ViewPager 复制而来
private const val MIN_FLING_VELOCITY = 400 // dips

/**
* 根据 offset 和 velocity 决定目标页面
*
* 经由原生 ViewPager 复制修改而来
* @author [Xeu](http://blog.usfl.cn)
* @param pageOffset 页面 offset ,介于 -1.0~1.0 之间,需减去由于 [PagerState.currentPage] 延迟更新
* 或打断动画导致 offset 超过 -1~1 范围的整数部分
* @param velocity 速度大小,大于0时速度指向下一页,小于0时指向上一页
* @return Int 目标页面 -1上一页 0当前页面 1下一页
*/
private fun determineTargetPage(
pageOffset: Float,
velocity: Float,
): Int {
    val density = Resources.getSystem().displayMetrics.density
    val currentPage = sign(pageOffset).toInt()
    val mMinimumVelocity = (MIN_FLING_VELOCITY * density).toInt()
    val mFlingDistance = (MIN_DISTANCE_FOR_FLING * density)
    var targetPage: Int =
    if (abs(pageOffset * width()) > mFlingDistance && abs(velocity) > mMinimumVelocity) {
        if (velocity * pageOffset < 0)
        0
        else
        currentPage
        } else {
            val truncator = if (currentPage >= 0) 0.4f else 0.6f
            currentPage + (pageOffset + truncator).toInt()
            }
            // Only let the user target pages we have items for
            targetPage = targetPage.coerceIn(-1, 1)
            return targetPage
            }
```



**使用示例**

```Groovy
implementation "com.google.accompanist:accompanist-pager:0.24.2-alpha"
val state = rememberPagerState()
HorizontalPager(
count = 5,
state = state,
contentPadding = PaddingValues(0.dp),
flingBehavior = pagerFlingBehavior(state = state),
) { page ->
    Box(
    Modifier.fillMaxSize(),
    contentAlignment = Alignment.Center
    ) {
        Text(text = "Page:$page")
        }
        }
```





**优化累计耗时：3h51min**