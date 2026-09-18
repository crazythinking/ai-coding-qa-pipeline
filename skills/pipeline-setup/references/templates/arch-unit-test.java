// ai-coding-qa-pipeline ArchUnit 结构门禁测试骨架(由 pipeline-setup 引导生成,B 类)。
// 落地:src/test/java/<pkg>/architecture/ArchitectureTest.java
// 命令: mvn -q arch-unit(实际是运行该测试;ComArchitectureTest 随 mvn test 执行)。
// 依赖:pom 需 com.tngtech.archunit:archunit-junit5。替换 <pkg> 为项目根包。
package <pkg>.architecture;

import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.*;

@AnalyzeClasses(packages = "<pkg>")
public class ArchitectureTest {

    // 控制器/应用层不得依赖基础设施层(按项目实际分层调整)
    @ArchTest
    static final ArchRule application_does_not_depend_on_infrastructure =
        noClasses().that().resideInAPackage("<pkg>.application..")
            .should().dependOnClassesThat().resideInAnyPackage("<pkg>.infrastructure..");

    // 禁止循环依赖(简化:各层只能依赖本层与更内层)
    @ArchTest
    static final ArchRule no_cycles_between_packages =
        slices().matching("<pkg>.(*)..").should().beFreeOfCycles();
}