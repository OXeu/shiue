---
title: "从零开始的Markdown解析器（一）"
date: 2023-01-13T01:04:52+08:00
draft: false
description: 因为太菜了所以决定自己造轮子
slug: kotlin-markdown
image: /104445433.jpg
categories:
- 造轮子系列
tags:
- 状态机
- Kotlin
---

> 封面来源 [破曉 | 亞爾特恩 #pixiv](https://www.pixiv.net/artworks/104445433)

## 引言

由于最近涉及到渲染 Markdown 的文章项目，而使用已经造好的轮子有很多地方无法满足自己的需求，比如大多数解析器都没有实现 `LaTex`语法的解析，而由于本人太菜，不会在此基础上二次修改解析器，只能依靠正则匹配对其进行缝缝补补。最终结果就是能用，但是不完全能用，Bug一大坨，改来改去还是没用，因此自己造Markdown解析器刻不容缓。

目前据我所知有三种 Markdown 解析器，一种为纯正则表达式进行匹配，但是由于每条正则表达式本身就是一个`有限状态自动机`，而想要进行完整的 Markdown 解析，所需要的正则表达式数量和复杂度都很高，性能上不是特别理想，但是只要优化够好，还是能够用的。

另一种为使用Flex与Yacc(Bison)生成词法分析器与语法分析器，进而由 Markdown 解析出 AST 树，该方法但由于我暂时对其具体的语法规则不是特别熟悉，在写规则期间异常痛苦，遂放弃。

第三种严格意义上属于第二种，但可能更加偏向从零开始徒手造轮子，就是手写有限状态机，由于 Markdown 语法规则较简单，状态数量虽然较多但完全手写也不算特别困难。我选择手写状态机的原因一方面是因为上文提到的对语法规则不熟悉导致第二种方法难以为继，另一方面则是是为了学习有限状态机。

## Markdown 解析格式简介

Markdown包含块语法与行内语法，块语法具体包含以下内容：

```
Heading 标题块
CodeBlock 代码块
RefBlock 引用块
Paragraph 普通文本段落
Divider 分割线
Table 表格
List 列表
```

行内语法包含以下内容（部分）：

```
Text 最普通的文本内容
Bold 加粗
Italic 斜体
Strikethrough 删除线
Link 链接
Image 图片
InlineCode 行内代码
------以下是扩展语法（不通用）------
QuickLink 快速链接: <https://usfl.cn> 等价于 [https://usfl.cn](https://usfl.cn)
Tooltip Tips提示：[可见文本][长按或鼠标悬浮后展示的文本]
```

其中大多数块语法内支持全部行内语法的使用，部分块语法支持部分或不支持行内语法，还有部分块语法支持嵌套块语法。此处将其分类的标准为是否需要在段首才生效。

> 引用块比较特殊，引用块内也可存在段首的条件，即引用块内所有块语法都能够生效，即使行首是引用语法的`>`

## 状态枚举

有限状态机通常包含状态、事件（条件）、动作、次态。

由于块语法都是从行首开始的，因此首先声明一个行首状态，并将各块语法作为次态。

其中事件为当前读入的字符，事件中多个字符表示所有可能的字符，次态中的变量`c`表示当前读入的字符

状态/次态中包含 `Pre`的表示中间状态，即可能为某种状态，需要后续字符继续进行推断。

事件中的`[Num]`表示数字，`[Space]`表示空白字符，等价于正则表达式的`\s`所表示的字符，`[Else]`表示默认规则，即无法匹配到其他事件时的默认处理，其余用`[]`包裹的符号等价于正则表达式。

| 状态           | 事件        | 动作 | 次态                       | 备注|
| -------------- | ----------- | ---- | -------------------------- | ----- |
| LineStart 行首 | #           |      | HeadingPre(1) 一级标题     | |
| LineStart      | `           |      | CodeBlockPre(1) 代码块预备 | 可能是代码块，也可能是行内代码 |
| LineStart      | >           |      | RefBlock 引用块            | |
| LineStart      | -=~ |      | DividerPre(1,c) 分割线预备    | 当<>为`~`时也有可能是行内删除线 |
| LineStart | \| |      | TablePre(1) 表格预备 | 也可能为普通的段落字符 |
| LineStart | *-[Num] | | ListPre(c) 列表预备 |  |
| LineStart | [Space] | | LineStart | 忽略行首空格 |
| LineStart | [Else] | | Paragraph 段落 | |

随后，列出所有次态对应的状态枚举：
| 状态           | 事件        | 动作 | 次态                       | 备注|
| -------------- | ----------- | ---- | -------------------------- | ----- |
| HeadingPre(n) | #          |      | HeadingPre(max{n+1,6}) | N+1级标题，最高为6级 |
| HeadingPre(n) | [Space] | | Heading(n) | 进入N级标题状态 |
| HeadingPre(n) | [Else] | | Paragraph("#".repeat(n)) | 状态转移至Paragraph，且向其追加已经扫描的"#"字符 |

| 状态           | 事件        | 动作 | 次态                       | 备注|
| -------------- | ----------- | ---- | -------------------------- | ----- |
| CodeBlockPre(n) | ` | | CodeBlockPre(n+1) |  |
| CodeBlockPre(n) | [Space] | | CodeBlockPre(n) | 忽略空格               |
| CodeBlockPre(n) | [\n] | | CodeBlock(n) | 进入代码块状态 |
| CodeBlockPre(n) | [A-Za-z] | | CodeBlockLangPre(n,c) | 指定代码块语言预备状态 |
| CodeBlockPre(n) | [Else] | | InlineCode(n,c) | 行内代码 |

由于枚举所有状态会占用大量篇幅，这里仅枚举以上状态作为示例。

## 最小可行性产品

由于完整对 Markdown 解析工程量较大，无法快速完成，遂需要先实现一个可运行的较小 Markdown 子集用于论证可行性并确定代码框架，我这里选取了仅解析`标题`和`纯文本段落`作为最小可行性产品（MVP）。

其中包含以下有限状态：

### 状态枚举

#### 根节点 Doc

根节点单篇 Markdown 文档中只有一个，作为解析 Markdown 的起点和 AST 树的最外层。

根节点的所有事件`[All]`都会指向LineStart

| 状态           | 事件      | 动作 | 次态                       | 备注|
| -------------- | ----------- | ---- | -------------------------- | ----- |
| Doc | [All] | | LineStart |  |

#### 行首 LineStart

所有块语法节点所必须的起始状态，这里为标题节点的起始状态

| 状态      | 事件    | 动作 | 次态          | 备注                                  |
| --------- | ------- | ---- | ------------- | ------------------------------------- |
| LineStart | #       |      | HeadingPre(1) | 可能为1级标题                         |
| LineStart | [Space] |      | LineStart     | 忽略行首空格                          |
| LineStart | [Else]  |      | Paragraph()   | 还需将当前读取的字符交由Paragraph处理 |

#### 标题预备 HeadingPre

进入`HeadingPre`状态表示已读入`n`个`#`字符，但还未读取到`[Space]`空格无法确定是否为标题

| 状态          | 事件    | 动作 | 次态                     | 备注                                                         |
| ------------- | ------- | ---- | ------------------------ | ------------------------------------------------------------ |
| HeadingPre(n) | #       |      | HeadingPre(n+1)          | 标题级数+1                                                   |
| HeadingPre(n) | [Space] |      | Heading                  | 进入标题状态                                                 |
| HeadingPre(n) | [Else]  |      | Paragraph("#".repeat(n)) | 将预读的n个`#`都交给Paragraph且需将当前预读的字符交由Paragraph处理 |

这里解释一下`[Else]`事件下为什么不直接把当前预读的字符传给Paragraph，因为当前预读的字符可能是类似`\n`或其他会触发`Paragraph`进入其他状态的字符，直接传入的话会导致状态仍停留在`Paragraph`状态下，出现状态异常的问题。

#### 标题 Heading

进入`Heading`状态即表示后续内容均会被按照指定标题级数的文本大小进行渲染，且 Heading 内的内容是文本段落，而当前 Markdown 子集内 Paragraph 只考虑了纯文本的情况，所以可以把 Heading 状态的下一状态直接指定为 `Paragraph`

| 状态    | 事件  | 动作 | 次态        | 备注 |
| ------- | ----- | ---- | ----------- | ---- |
| Heading | [All] |      | Paragraph() |      |

#### 段落 Paragraph

完整的 Markdown支持下 `Paragraph` 内应包含所有行内语法，这里的子集只实现了纯文本

| 状态              | 事件   | 动作    | 次态                | 备注                                                |
| ----------------- | ------ | ------- | ------------------- | --------------------------------------------------- |
| Paragraph(string) | [\n]   | Exit(c) | Parent              | 当事件为`\n`换行符时退出Paragraph状态，返回上一状态 |
| Paragraph(string) | [Else] |         | Paragraph(string+c) | 其他段落内字符直接追加                              |

可以发现，`Paragraph` 里出现了 `Parent`和`Exit`退出动作，即退出`Paragraph`节点返回父节点，因此我们不得不需要考虑补充其他状态下的退出状态。

#### 补充

| 状态       | 事件 | 动作 | 次态   | 备注                     |
| ---------- | ---- | ---- | ------ | ------------------------ |
| Heading    | [\n] | Exit | Parent | 标题节点无法处理\n换行符 |
| HeadingPre    | [\n] | Exit | Parent | 标题预备节点无法处理\n换行符 |
| LineStart    | [\n] | Exit | Parent | 行首节点无法处理\n换行符 |
| Doc    | [\n] |  | LineStart | 根节点读取\n换行符，进入到新的行首状态 |

### 代码实现

首先定义抽象类`BaseNode`作为所有节点的基类

```kt
// ./node/BaseNode.kt
package node
/** 
  * BaseNode 所有节点的基类
  * @param hide 是否隐藏当前类型的节点（节点为中间节点不需要打印显示时设置为 true ）
  */
abstract class BaseNode(val hide: Boolean = false) {
    val list = mutableListOf<BaseNode>() // 当前节点的所有子节点列表
    
    // 读取字符，返回下一个状态
    abstract fun next(c: Char): BaseNode 
    
    // 子节点退出时调用，返回下一个状态
    abstract fun exit(c: Char): BaseNode
    
    // 将下一个状态放入当前节点的子节点列表
    // 返回传入的子节点便于将其作为一个包裹函数，具体查看后续代码
    fun push(child: BaseNode): BaseNode {
        list.add(child)
        return child
    }
    
    // 输出 AST 树
    override fun toString(): String {
        val listToString = list.joinToString { it.toString() }
        return if (hide) {
            listToString
        } else {
            "${javaClass.simpleName} { $listToString }"
        }
    }
}
```

考虑到退出当前节点返回到上一节点与读取下一个字符中的事件处理可能并不相同，为了解耦代码讲起定义为了两个方法。

随后分别实现各个节点：

```kt
// ./node/Doc.kt
package node

/**
 * Doc 根节点
 */
class Doc : BaseNode() {
    // 所有字符的次态均为 LineStart，将其放入子节点列表后再将当前读取的字符交由其处理
    override fun next(c: Char): BaseNode {
        return push(LineStart(this)).next(c)
    }
    
    // 子节点退出函数，不做任何处理
    override fun exit(c: Char): BaseNode {
        when (c) {
            // 目前无意义，用于后续推广子集
            '\n' -> {}
        }
        return this
    }
}
```

```kt
// ./node/LineStart.kt
package node
/**
 * hide = true 中间层。展示 AST节点树时隐藏该节点
 */
class LineStart(private val parent: BaseNode) : BaseNode(hide = true) {
    override fun next(c: Char): BaseNode {
        val nextState = when (c) {
            '#' -> push(HeadingPre(this, 1))
            ' ' -> push(LineStart(this))
            else -> push(Paragraph(this, "")).next(c)
        }
        return nextState
    }

    /**
     * 子节点退出函数
     * 当退出事件为 \n 或 \0 时调用退出当前 LineStart 节点返回至父节点
     * 其他情况下不退出
     */
    override fun exit(c: Char): BaseNode {
        when (c) {
            '\n', Char(0) -> {
                return parent.exit(c)
            }
        }
        return this
    }
}
```

```kt
// ./node/Heading.kt
package node

/**
 * hide = true 中间层。展示 AST节点树时隐藏该节点
 */
class HeadingPre(private val parent: BaseNode, count: Int) : BaseNode(hide = true) {
    // 该节点对应的标题级数
    private val sharpCount: Int = count
    override fun next(c: Char): BaseNode {
        val nextState = when (c) {
            '#' -> push(HeadingPre(this, sharpCount + 1))
            ' ' -> push(Heading(this, sharpCount))
            else -> push(Paragraph(this, "#".repeat(sharpCount))).next(c)
        }
        return nextState
    }

    /**
     * 子节点退出函数
     * 当退出事件为 \n 或 \0 时调用退出当前 HeadingPre 节点返回至父节点
     * 其他情况下不退出
     */
    override fun exit(c: Char): BaseNode {
        when (c) {
            '\n', Char(0) -> {
                return parent.exit(c)
            }
        }
        return this
    }
}

class Heading(private val parent: BaseNode, count: Int) : BaseNode() {
    // 该节点对应的标题级数
    private val sharpCount: Int = count

    override fun next(c: Char): BaseNode {
        return push(Paragraph(this, c.toString()))
    }

    /**
     * 子节点退出函数
     * 当退出事件为 \n 或 \0 时调用退出当前 Heading 节点返回至父节点
     * 其他情况下不退出
     */
    override fun exit(c: Char): BaseNode {
        when (c) {
            '\n', Char(0) -> {
                return parent.exit(c)
            }
        }
        return this
    }
    
    // 重写 toString 函数用于展示标题级数
    override fun toString(): String {
        val listToString = list.joinToString { it.toString() }
        return "${javaClass.simpleName}${sharpCount} { $listToString }"
    }
}
```

```kt
// ./node/Paragraph.kt
package node

class Paragraph(private val parent: BaseNode, str: String) : BaseNode() {
    // 保存的文本内容
    private var chars = StringBuilder(str)
    override fun next(c: Char): BaseNode {
        return when (c) {
            '\n' -> {
                // 调用退出函数退出当前 Paragraph 节点
                exit('\n')
            }

            else -> {
                chars.append(c)
                this
            }
        }
    }

    override fun exit(c: Char): BaseNode {
        return parent.exit(c)
    }

    // 重写 toString 函数展示文字内容
    override fun toString(): String {
        return "Paragraph(${chars})"
    }

}
```

接下来就是实现状态机：

```kt
// ./Decoder.kt
import node.BaseNode
import node.Doc

object Decoder {
    fun tree(str: String): BaseNode {
        var state: BaseNode = Doc() // 定义初始状态为根节点
        str.forEach {// 逐字符遍历 Markdown 文本 
            state = state.next(it) // 进入到下一状态
        }
        return state.exit(Char(0)) // 结束，退出所有节点返回根节点
    }
}
```

最后编写`main`函数进行测试：

```kt
// ./Main.kt
fun main() {
    println("========")
    val md = "# 一级标题\n## 二级标题\n段落测试\n这是一个段落\n###伪标题测试\n################ 16级标题测试"
    println(md)
    println("========")
    val st = System.nanoTime()
    val tree = Decoder.tree(md)
    val t2 = System.nanoTime()
    println("[生成 AST 节点树耗时 ${(t2 - st) / 1000_000f} ms]")
    println(tree)
    println("[打印耗时 ${(System.nanoTime() - t2) / 1000_000f} ms]")
}
```

输出结果：

```
========
# 一级标题
## 二级标题
段落测试
这是一个段落
###伪标题测试
################ 16级标题测试
========
[生成 AST 节点树耗时 12.0119 ms]
Doc { Heading1 { Paragraph(一级标题) }, Heading2 { Paragraph(二级标题) }, Paragraph(段落测试), Paragraph(这是一个段落), Paragraph(###伪标题测试), Heading16 { Paragraph(16级标题测试) } }
[打印耗时 11.3503 ms]
```

节点树格式化后：

```
Doc { 
	Heading1 { 
		Paragraph(一级标题) 
	},
    Heading2 { 
    	Paragraph(二级标题) 
    },
    Paragraph(段落测试),
    Paragraph(这是一个段落),
    Paragraph(###伪标题测试), 
    Heading16 { 
    	Paragraph(16级标题测试) 
    } 
}
```

完成的节点树为：

```
Doc { 
	LineStart { 
		HeadingPre { 
			Heading1 { 
				Paragraph(一级标题) 
			} 
		} 
	},
    LineStart { 
    	HeadingPre { 
    		HeadingPre { 
    			Heading2 { 
    			Paragraph(二级标题) 
    			} 
    		} 
    	} 
     },
     LineStart { 
	     Paragraph(段落测试)
     },
     LineStart { 
     	Paragraph(这是一个段落) 
     }, 
     LineStart { 
     	HeadingPre { 
     		HeadingPre { 
     			HeadingPre { 
     				Paragraph(###伪标题测试) 
     			} 
     		} 
     	} 
     },
     LineStart { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	HeadingPre { 
     	Heading16 { 
     		Paragraph(16级标题测试)
        } } } } } } } } } } } } } } } } } 
	} 
}

```

可以看到当用户胡乱输入一个 16级标题后会生成一个嵌套16层HeadingPre的Heading，不美观的同时也不太符合 Markdown 标准（虽然Markdown并没有统一的标准，不过通常会按照HTML的标签，也就是最小到六级标题结束，因此可以在HeadingPre中加入一定限制，不过这里就不再赘述了）